//! El video de `screenrecord --output-format=h264`, cortado en cuadros que la vista puede
//! decodificar con WebCodecs apenas llegan.
//!
//! - **El corte.** En Annex B un NAL termina donde empieza el siguiente. Un cuadro sale en
//!   cuanto se ve la cabecera del NAL que abre el próximo; el último de una ráfaga, cuando
//!   quien lee el stream avisa que el pipe lleva unos milisegundos quieto ([`Splitter::idle`]).
//! - **El SPS.** Muchos encoders no dicen cuántos cuadros pueden reordenar, y un
//!   decodificador basado en ffmpeg se guarda varios por las dudas. Se reescribe con
//!   `max_num_reorder_frames = 0` (lo mismo que hace Moonlight). Aun así, el pipeline de
//!   WebKitGTK retiene uno: la vista lo compensa con una captura cuando el video se aquieta.

/// Un tipo de NAL: los 5 bits bajos del primer byte.
fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map_or(0, |b| b & 0x1f)
}

/// Saca los bytes de prevención de emulación (`00 00 03` → `00 00`).
pub fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

/// Los vuelve a poner, para que ningún `00 00 0x` del contenido parezca un inicio de NAL.
pub fn escape(rbsp: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rbsp.len() + 8);
    let mut zeros = 0;
    for &b in rbsp {
        if zeros >= 2 && b <= 3 {
            out.push(3);
            zeros = 0;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.pos / 8)?;
        let bit = (byte >> (7 - self.pos % 8)) & 1;
        self.pos += 1;
        Some(u32::from(bit))
    }

    fn bits(&mut self, n: u32) -> Option<u32> {
        (0..n).try_fold(0u32, |acc, _| Some((acc << 1) | self.bit()?))
    }

    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.bits(zeros)?)
    }
}

#[derive(Default)]
struct Writer {
    out: Vec<u8>,
    used: u8,
}

impl Writer {
    fn bit(&mut self, bit: u32) {
        if self.used == 0 {
            self.out.push(0);
        }
        if bit & 1 == 1 {
            *self.out.last_mut().expect("hay un byte") |= 1 << (7 - self.used);
        }
        self.used = (self.used + 1) % 8;
    }

    fn bits(&mut self, value: u32, n: u32) {
        for i in (0..n).rev() {
            self.bit(value >> i);
        }
    }

    fn ue(&mut self, value: u32) {
        let v = u64::from(value) + 1;
        let len = 64 - v.leading_zeros();
        self.bits(0, len - 1);
        for i in (0..len).rev() {
            self.bit(((v >> i) & 1) as u32);
        }
    }

    /// El bit de parada y el relleno hasta el byte.
    fn finish(mut self) -> Vec<u8> {
        self.bit(1);
        while self.used != 0 {
            self.bit(0);
        }
        self.out
    }
}

/// Lee de uno y escribe lo mismo en el otro: así se copia el SPS campo por campo hasta la
/// parte que hay que cambiar.
struct Copy<'a> {
    r: Bits<'a>,
    w: Writer,
}

impl Copy<'_> {
    fn u(&mut self, n: u32) -> Option<u32> {
        let v = self.r.bits(n)?;
        self.w.bits(v, n);
        Some(v)
    }

    fn ue(&mut self) -> Option<u32> {
        let v = self.r.ue()?;
        self.w.ue(v);
        Some(v)
    }

    /// Un `se(v)` se codifica igual que un `ue(v)`: copiarlo como tal alcanza.
    fn se(&mut self) -> Option<()> {
        self.ue().map(|_| ())
    }

    fn scaling_list(&mut self, size: usize) -> Option<()> {
        let (mut last, mut next) = (8i32, 8i32);
        for _ in 0..size {
            if next != 0 {
                let code = self.r.ue()?;
                self.w.ue(code);
                let delta = if code % 2 == 1 { (code as i32 + 1) / 2 } else { -(code as i32 / 2) };
                next = (last + delta + 256) % 256;
            }
            if next != 0 {
                last = next;
            }
        }
        Some(())
    }

    fn hrd(&mut self) -> Option<()> {
        let count = self.ue()? + 1;
        self.u(8)?; // bit_rate_scale, cpb_size_scale
        for _ in 0..count {
            self.ue()?;
            self.ue()?;
            self.u(1)?;
        }
        self.u(20) // cuatro largos de 5 bits
            .map(|_| ())
    }
}

/// Lo que importa del SPS para mostrarlo.
#[derive(Debug, Clone, PartialEq)]
pub struct SpsInfo {
    pub width: u32,
    pub height: u32,
    /// Cuántos cuadros dice el SPS original que se pueden reordenar. `None` = no lo dice,
    /// y el decodificador se guarda cuadros por las dudas. El reescrito siempre dice 0.
    pub reorder: Option<u32>,
}

/// El SPS (un NAL completo, con su byte de cabecera) reescrito para que el decodificador
/// no retenga cuadros, y lo que dice. `None` si no se pudo leer: entonces se usa el original.
pub fn low_latency_sps(nal: &[u8]) -> Option<(Vec<u8>, SpsInfo)> {
    if nal_type(nal) != 7 || nal.len() < 4 {
        return None;
    }
    let rbsp = unescape(&nal[1..]);
    let mut c = Copy { r: Bits { data: &rbsp, pos: 0 }, w: Writer::default() };
    let profile = c.u(8)?;
    c.u(16)?; // restricciones y nivel
    c.ue()?; // seq_parameter_set_id
    let mut chroma = 1;
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        chroma = c.ue()?;
        if chroma == 3 {
            c.u(1)?;
        }
        c.ue()?;
        c.ue()?;
        c.u(1)?;
        if c.u(1)? == 1 {
            for i in 0..if chroma == 3 { 12 } else { 8 } {
                if c.u(1)? == 1 {
                    c.scaling_list(if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    c.ue()?; // log2_max_frame_num
    match c.ue()? {
        0 => {
            c.ue()?;
        }
        1 => {
            c.u(1)?;
            c.se()?;
            c.se()?;
            for _ in 0..c.ue()? {
                c.se()?;
            }
        }
        _ => {}
    }
    let refs = c.ue()?;
    c.u(1)?;
    let width_mbs = c.ue()? + 1;
    let height_units = c.ue()? + 1;
    let frame_mbs_only = c.u(1)?;
    if frame_mbs_only == 0 {
        c.u(1)?;
    }
    c.u(1)?;
    let mut crop = [0u32; 4];
    if c.u(1)? == 1 {
        for v in &mut crop {
            *v = c.ue()?;
        }
    }
    let (crop_x, crop_y) = match chroma {
        0 => (1, 2 - frame_mbs_only),
        1 => (2, 2 * (2 - frame_mbs_only)),
        2 => (2, 2 - frame_mbs_only),
        _ => (1, 2 - frame_mbs_only),
    };
    let width = (width_mbs * 16).saturating_sub(crop_x * (crop[0] + crop[1]));
    let height = (height_units * 16 * (2 - frame_mbs_only)).saturating_sub(crop_y * (crop[2] + crop[3]));

    // VUI: se copia tal cual hasta bitstream_restriction, que se escribe de nuevo.
    let had_vui = c.r.bit()?;
    c.w.bit(1);
    let mut mv_boundaries = 1;
    let mut buffering = refs.max(1);
    let mut reorder = None;
    if had_vui == 1 {
        if c.u(1)? == 1 && c.u(8)? == 255 {
            c.u(32)?;
        }
        if c.u(1)? == 1 {
            c.u(1)?;
        }
        if c.u(1)? == 1 {
            c.u(4)?;
            if c.u(1)? == 1 {
                c.u(24)?;
            }
        }
        if c.u(1)? == 1 {
            c.ue()?;
            c.ue()?;
        }
        if c.u(1)? == 1 {
            c.u(32)?;
            c.u(32)?;
            c.u(1)?;
        }
        let nal_hrd = c.u(1)?;
        if nal_hrd == 1 {
            c.hrd()?;
        }
        let vcl_hrd = c.u(1)?;
        if vcl_hrd == 1 {
            c.hrd()?;
        }
        if nal_hrd == 1 || vcl_hrd == 1 {
            c.u(1)?;
        }
        c.u(1)?; // pic_struct_present
        if c.r.bit()? == 1 {
            mv_boundaries = c.r.bit()?;
            for _ in 0..4 {
                c.r.ue()?;
            }
            reorder = Some(c.r.ue()?); // max_num_reorder_frames: se reemplaza
            buffering = c.r.ue()?.max(1);
        }
    } else {
        // Sin VUI: todos los bloques vacíos (aspecto, overscan, señal, croma, tiempos, dos
        // HRD y pic_struct) hasta bitstream_restriction.
        c.w.bits(0, 8);
    }
    let w = &mut c.w;
    w.bit(1); // bitstream_restriction_flag
    w.bit(mv_boundaries);
    w.ue(0); // max_bytes_per_pic_denom
    w.ue(0); // max_bits_per_mb_denom
    w.ue(16);
    w.ue(16);
    w.ue(0); // max_num_reorder_frames
    w.ue(buffering);
    let mut out = vec![nal[0]];
    out.extend(escape(&c.w.finish()));
    Some((out, SpsInfo { width, height, reorder }))
}

/// Qué dice un SPS, sin cambiarlo.
#[cfg(test)]
pub fn sps_info(nal: &[u8]) -> Option<SpsInfo> {
    low_latency_sps(nal).map(|(_, info)| info)
}

/// El `avcC` (AVCDecoderConfigurationRecord) que WebCodecs recibe como `description`.
pub fn avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut out = vec![1, sps[1], sps[2], sps[3], 0xff, 0xe1];
    out.extend((sps.len() as u16).to_be_bytes());
    out.extend(sps);
    out.push(1);
    out.extend((pps.len() as u16).to_be_bytes());
    out.extend(pps);
    out
}

/// `avc1.PPCCLL`, el nombre del códec para `VideoDecoder.configure`.
pub fn codec_name(sps: &[u8]) -> String {
    format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3])
}

/// Lo que sale del stream, listo para mandar a la vista.
#[derive(Debug, Clone, PartialEq)]
pub enum Unit {
    /// Un SPS y un PPS nuevos: el decodificador se configura de nuevo.
    Config { codec: String, avcc: Vec<u8>, width: u32, height: u32 },
    /// Un cuadro, con sus NAL en formato AVC (cada uno con su largo en 4 bytes).
    Frame { key: bool, data: Vec<u8> },
    /// Lo que llegó no encaja con lo que se dio por cerrado: hay que volver a empezar.
    Broken,
}

/// Corta el stream Annex B en cuadros.
#[derive(Default)]
pub struct Splitter {
    buf: Vec<u8>,
    sps: Option<(Vec<u8>, SpsInfo)>,
    pps: Option<Vec<u8>>,
    /// Hay un SPS o PPS que la vista todavía no tiene.
    config_pending: bool,
    frame: Vec<u8>,
    key: bool,
    /// Lo último se dio por cerrado sin ver el siguiente inicio: lo que llegue tiene que
    /// empezar con uno.
    closed_early: bool,
    /// Hasta el próximo cuadro clave no se manda nada (después de un corte mal hecho).
    need_key: bool,
}

/// Dónde empieza el próximo `00 00 01` desde `from`, y cuántos bytes ocupa el inicio
/// (`00 00 01` o `00 00 00 01`).
fn find_start(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut i = from;
    while i + 3 <= buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 {
            return Some(if i > from && buf[i - 1] == 0 { (i - 1, 4) } else { (i, 3) });
        }
        i += 1;
    }
    None
}

impl Splitter {
    /// Agrega lo que se leyó y devuelve lo que quedó completo.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<Unit> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        if self.closed_early {
            // Lo próximo tiene que ser un inicio de NAL. Si antes vienen otros bytes, lo que
            // se dio por cerrado estaba incompleto.
            let prefix = find_start(&self.buf, 0).map_or(self.buf.len(), |(at, _)| at);
            if self.buf[..prefix].iter().any(|b| *b != 0) {
                self.closed_early = false;
                self.need_key = true;
                out.push(Unit::Broken);
            } else if prefix < self.buf.len() {
                self.closed_early = false;
            } else {
                return out;
            }
        }
        // Lo de antes del primer inicio se descarta; cada NAL termina donde empieza el otro.
        let Some(mut current) = find_start(&self.buf, 0) else { return out };
        while let Some(next) = find_start(&self.buf, current.0 + current.1) {
            let nal = self.buf[current.0 + current.1..next.0].to_vec();
            self.nal(&nal, &mut out);
            current = next;
        }
        // Si ya se ve la cabecera del que sigue y abre otro cuadro, el actual está completo.
        let head = current.0 + current.1;
        let opens_frame = match self.buf.get(head).map(|b| b & 0x1f) {
            Some(7..=9) => true,
            Some(1 | 5) => self.buf.get(head + 1).is_some_and(|b| b & 0x80 != 0),
            _ => false,
        };
        if opens_frame {
            self.flush(&mut out);
        }
        // Queda el último, que todavía no se sabe dónde termina, con su inicio.
        self.buf.drain(..current.0);
        out
    }

    /// El pipe lleva un rato sin datos: lo pendiente está completo.
    pub fn idle(&mut self) -> Vec<Unit> {
        let mut out = Vec::new();
        if let Some((at, len)) = find_start(&self.buf, 0) {
            let nal = self.buf[at + len..].to_vec();
            if !nal.is_empty() {
                self.buf.clear();
                self.closed_early = true;
                self.nal(&nal, &mut out);
            }
        }
        self.flush(&mut out);
        out
    }

    fn nal(&mut self, nal: &[u8], out: &mut Vec<Unit>) {
        let mut end = nal.len();
        while end > 1 && nal[end - 1] == 0 {
            end -= 1;
        }
        let nal = &nal[..end];
        match nal_type(nal) {
            7 => {
                self.flush(out);
                let parsed = low_latency_sps(nal).or_else(|| {
                    let info = SpsInfo { width: 0, height: 0, reorder: None };
                    Some((nal.to_vec(), info))
                });
                self.sps = parsed;
                self.config_pending = true;
            }
            8 => {
                self.flush(out);
                self.pps = Some(nal.to_vec());
                self.config_pending = true;
            }
            9 => self.flush(out),
            t @ (1 | 5) => {
                // first_mb_in_slice == 0 (su ue empieza con un 1): empieza otro cuadro.
                if nal.get(1).is_some_and(|b| b & 0x80 != 0) {
                    self.flush(out);
                }
                if self.config_pending
                    && let (Some((sps, info)), Some(pps)) = (&self.sps, &self.pps)
                {
                    out.push(Unit::Config {
                        codec: codec_name(sps),
                        avcc: avcc(sps, pps),
                        width: info.width,
                        height: info.height,
                    });
                    self.config_pending = false;
                }
                self.frame.extend((nal.len() as u32).to_be_bytes());
                self.frame.extend(nal);
                self.key |= t == 5;
            }
            // SEI y lo demás no hacen falta para mostrar la pantalla.
            _ => {}
        }
    }

    fn flush(&mut self, out: &mut Vec<Unit>) {
        if self.frame.is_empty() {
            return;
        }
        let data = std::mem::take(&mut self.frame);
        let key = std::mem::take(&mut self.key);
        if self.need_key && !key {
            return;
        }
        self.need_key = false;
        out.push(Unit::Frame { key, data });
    }
}
