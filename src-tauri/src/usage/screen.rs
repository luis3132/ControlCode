//! Reconstruir la pantalla que dibujó la TUI, para poder leerla.
//!
//! ## Por qué no alcanza con quitarle los escapes
//!
//! Una TUI no escribe renglones: mueve el cursor y pinta. El panel de `/usage` separa las
//! columnas con `CSI C` (avanzar N) en vez de espacios, y repinta el mismo lugar varias
//! veces mientras carga. Si al flujo crudo solo se le sacan los escapes, queda
//! `Currentweek(allmodels)` —sin los espacios que nunca se escribieron— y las pintadas
//! sucesivas se leen una atrás de otra, mezcladas. Así, `Current week (all models)` no
//! aparece nunca y el número que se encontraba era el de otra barra.
//!
//! Acá se aplica el flujo sobre una grilla, como haría la terminal: cada carácter va a su
//! fila y columna, y lo que se repinta pisa lo anterior. Lo que sale es lo que el usuario
//! habría visto, y eso ya se puede leer por renglones.
//!
//! Es un subconjunto de VT100: lo que usa esta clase de TUI (mover, borrar, insertar y
//! eliminar renglones). Lo que no se entiende se ignora, que es lo que hace una terminal
//! con una secuencia que no conoce.

/// El tamaño con el que se abre la PTY del sondeo (ver `live.rs`). La grilla tiene que ser
/// la misma o el panel se dibujaría con otro ancho del que la TUI creyó tener.
pub(super) const ROWS: usize = 45;
pub(super) const COLS: usize = 100;

struct Screen {
    grid: Vec<Vec<char>>,
    /// Los renglones que se fueron por arriba. Se conservan: el panel puede ser más largo
    /// que la pantalla, y lo que salió de la grilla ya no se repinta más.
    scrollback: Vec<String>,
    row: usize,
    col: usize,
    saved: (usize, usize),
}

impl Screen {
    fn new() -> Self {
        Screen {
            grid: vec![vec![' '; COLS]; ROWS],
            scrollback: Vec::new(),
            row: 0,
            col: 0,
            saved: (0, 0),
        }
    }

    fn scroll(&mut self) {
        let gone: String = self.grid.remove(0).into_iter().collect();
        self.scrollback.push(gone.trim_end().to_string());
        self.grid.push(vec![' '; COLS]);
    }

    /// Deja el cursor dentro de la grilla, desplazando lo que haga falta.
    fn settle(&mut self) {
        while self.row >= ROWS {
            self.scroll();
            self.row -= 1;
        }
    }

    fn put(&mut self, ch: char) {
        if self.col >= COLS {
            self.col = 0;
            self.row += 1;
        }
        self.settle();
        self.grid[self.row][self.col] = ch;
        self.col += 1;
    }

    fn blank_row(&mut self, row: usize, from: usize, to: usize) {
        if row >= ROWS {
            return;
        }
        for col in from..to.min(COLS) {
            self.grid[row][col] = ' ';
        }
    }

    fn text(&self) -> String {
        let visible = self.grid.iter().map(|row| row.iter().collect::<String>().trim_end().to_string());
        self.scrollback.iter().cloned().chain(visible).collect::<Vec<_>>().join("\n")
    }
}

/// Los números de una secuencia CSI (`1;31` → `[1, 31]`).
fn params(raw: &str) -> Vec<usize> {
    raw.split(';').map(|p| p.trim().parse::<usize>().unwrap_or(0)).collect()
}

/// La pantalla final, renglón por renglón, tal como se habría visto.
pub(super) fn render(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut screen = Screen::new();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if ch != '\u{1b}' {
            i += 1;
            match ch {
                '\r' => screen.col = 0,
                '\n' => {
                    screen.row += 1;
                    screen.settle();
                }
                '\u{8}' => screen.col = screen.col.saturating_sub(1),
                '\t' => screen.col = ((screen.col / 8) + 1) * 8,
                // Los de control que no son movimiento no se dibujan.
                c if c < ' ' => {}
                c => screen.put(c),
            }
            continue;
        }

        i += 1;
        match chars.get(i) {
            Some('[') => {
                i += 1;
                let start = i;
                while i < chars.len() && !chars[i].is_ascii_alphabetic() {
                    i += 1;
                }
                let body: String = chars[start..i].iter().collect();
                let final_byte = chars.get(i).copied().unwrap_or('m');
                i += 1;

                // `CSI ? …`: modos privados (cursor visible, pantalla alterna). No mueven
                // ni pintan nada de lo que interesa.
                if body.starts_with('?') {
                    continue;
                }
                let nums = params(&body);
                let first = nums.first().copied().unwrap_or(0);
                let steps = first.max(1);

                match final_byte {
                    'H' | 'f' => {
                        screen.row = nums.first().copied().unwrap_or(1).saturating_sub(1);
                        screen.col = nums.get(1).copied().unwrap_or(1).saturating_sub(1);
                        screen.settle();
                    }
                    'A' => screen.row = screen.row.saturating_sub(steps),
                    'B' => {
                        screen.row += steps;
                        screen.settle();
                    }
                    'C' => screen.col = (screen.col + steps).min(COLS - 1),
                    'D' => screen.col = screen.col.saturating_sub(steps),
                    'G' => screen.col = steps.saturating_sub(1).min(COLS - 1),
                    // Borrar desde el cursor, hasta el cursor, o todo.
                    'J' => match first {
                        1 => {
                            for row in 0..screen.row.min(ROWS) {
                                screen.blank_row(row, 0, COLS);
                            }
                            let (row, col) = (screen.row, screen.col);
                            screen.blank_row(row, 0, col + 1);
                        }
                        2 | 3 => screen.grid = vec![vec![' '; COLS]; ROWS],
                        _ => {
                            let (row, col) = (screen.row, screen.col);
                            screen.blank_row(row, col, COLS);
                            for row in row + 1..ROWS {
                                screen.blank_row(row, 0, COLS);
                            }
                        }
                    },
                    'K' => {
                        let (row, col) = (screen.row, screen.col);
                        match first {
                            1 => screen.blank_row(row, 0, col + 1),
                            2 => screen.blank_row(row, 0, COLS),
                            _ => screen.blank_row(row, col, COLS),
                        }
                    }
                    // Insertar y eliminar renglones: la TUI las usa para correr bloques.
                    'L' => {
                        for _ in 0..steps {
                            if screen.row < ROWS {
                                screen.grid.insert(screen.row, vec![' '; COLS]);
                                screen.grid.truncate(ROWS);
                            }
                        }
                    }
                    'M' => {
                        for _ in 0..steps {
                            if screen.row < ROWS {
                                screen.grid.remove(screen.row);
                                screen.grid.push(vec![' '; COLS]);
                            }
                        }
                    }
                    'S' => {
                        for _ in 0..steps {
                            screen.scroll();
                        }
                    }
                    's' => screen.saved = (screen.row, screen.col),
                    'u' => {
                        (screen.row, screen.col) = screen.saved;
                        screen.settle();
                    }
                    // Color, estilo y lo demás no cambian dónde queda el texto.
                    _ => {}
                }
            }
            // OSC: título de la ventana y compañía. Termina en BEL o en ST.
            Some(']') => {
                while i < chars.len() && chars[i] != '\u{7}' {
                    if chars[i] == '\u{1b}' && chars.get(i + 1) == Some(&'\\') {
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            Some('7') => {
                screen.saved = (screen.row, screen.col);
                i += 1;
            }
            Some('8') => {
                (screen.row, screen.col) = screen.saved;
                screen.settle();
                i += 1;
            }
            // Secuencias de dos caracteres (juegos de caracteres, por ejemplo).
            Some(_) => i += 1,
            None => break,
        }
    }

    screen.text()
}
