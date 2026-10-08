//! Las palabras que una TUI usa mientras trabaja ("Hyperspacing…"), leídas de ella.
//!
//! El chat en modo HTML muestra una de estas al lado del reloj, igual que la consola. La
//! lista **no se escribe acá**: es de Claude Code, viene adentro de su binario, y cambia
//! entre versiones. Copiarla al código de la app sería meter su texto en nuestro producto y
//! además envejecería sola; leerla de la instalación que la persona ya tiene la mantiene
//! al día y deja que el texto siga siendo de quien es.
//!
//! Cómo están guardadas: el bundle las deja como cadenas contiguas, una detrás de otra con
//! unos pocos bytes de cabecera en el medio (`…\x0c\0\0\x80…Hyperspacing\0\x08\0\0\x80…
//! Ideating…`). Así que se buscan **tiras largas** de gerundios capitalizados seguidos: una
//! palabra suelta en cualquier otra parte del binario no alcanza para colarse.

use std::io::Read;

/// Cuántos bytes de basura se toleran entre dos palabras de la misma tira. En el bundle
/// hay ~8 de cabecera entre una y la siguiente; con más tolerancia se cuelan palabras que
/// solo estaban cerca (un "Loading" de otro texto, por ejemplo).
const MAX_GAP: usize = 16;
/// Cuántas palabras seguidas hacen una tira creíble. Las listas reales tienen decenas.
const MIN_RUN: usize = 20;
/// Tope de lo que se devuelve, por si algún día el formato cambia y la heurística se
/// entusiasma.
const MAX_WORDS: usize = 500;

const CHUNK: usize = 4 << 20;
/// Lo que se arrastra entre pedazos para no partir una palabra al medio.
const CARRY: usize = 64;

lazy_static::lazy_static! {
    static ref GERUND: regex::bytes::Regex =
        regex::bytes::Regex::new(r"[A-Z][a-z]{2,24}ing").expect("la expresión es constante");
}

/// Las palabras de una tira larga, en el orden en que están. Vacío = no se encontró nada
/// que parezca una lista, y entonces quien llama muestra su texto de siempre.
pub fn scan_words(mut source: impl Read) -> Vec<String> {
    let mut found: Vec<(usize, usize, String)> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let mut window: Vec<u8> = Vec::with_capacity(CHUNK + CARRY);
    let mut base = 0usize;

    loop {
        let read = match source.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        window.extend_from_slice(&buf[..read]);
        for m in GERUND.find_iter(&window) {
            let start = base + m.start();
            // Lo que ya se vio en el arrastre del pedazo anterior no se cuenta dos veces.
            if found.last().is_some_and(|(s, _, _)| *s >= start) {
                continue;
            }
            found.push((start, base + m.end(), String::from_utf8_lossy(m.as_bytes()).into_owned()));
        }
        let keep = window.len().min(CARRY);
        base += window.len() - keep;
        window.drain(..window.len() - keep);
    }

    runs(&found)
}

/// Agrupa en tiras y devuelve las palabras de las que son lo bastante largas, sin repetir.
fn runs(found: &[(usize, usize, String)]) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    let mut run: Vec<&String> = Vec::new();
    let mut prev_end = 0usize;

    let flush = |run: &mut Vec<&String>, words: &mut Vec<String>| {
        if run.len() >= MIN_RUN {
            for w in run.iter() {
                if !words.contains(w) && words.len() < MAX_WORDS {
                    words.push((*w).clone());
                }
            }
        }
        run.clear();
    };

    for (start, end, word) in found {
        if !run.is_empty() && start.saturating_sub(prev_end) > MAX_GAP {
            flush(&mut run, &mut words);
        }
        run.push(word);
        prev_end = *end;
    }
    flush(&mut run, &mut words);
    words
}

/// Las palabras de la TUI instalada. Se cachea por binario y tamaño: recorrer 250 MB una
/// vez por versión está bien; una vez por tab, no.
#[tauri::command]
pub async fn agent_words(agent_id: String) -> Vec<String> {
    lazy_static::lazy_static! {
        static ref CACHE: std::sync::Mutex<std::collections::HashMap<String, Vec<String>>> =
            std::sync::Mutex::new(std::collections::HashMap::new());
    }
    let Some(command) = super::registry::agent_command(&agent_id) else { return Vec::new() };
    let Some(path) = crate::util::find_program(command) else { return Vec::new() };
    // El binario real: `claude` suele ser un lanzador que apunta a la versión instalada.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let key = match std::fs::metadata(&path) {
        Ok(meta) => format!("{}:{}", path.to_string_lossy(), meta.len()),
        Err(_) => return Vec::new(),
    };
    if let Ok(cache) = CACHE.lock() {
        if let Some(hit) = cache.get(&key) {
            return hit.clone();
        }
    }

    let words = tauri::async_runtime::spawn_blocking(move || match std::fs::File::open(&path) {
        Ok(file) => scan_words(std::io::BufReader::new(file)),
        Err(_) => Vec::new(),
    })
    .await
    .unwrap_or_default();

    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(key, words.clone());
    }
    words
}
