//! Claves, cifrado de punta a punta e identidades.
//!
//! Es `crypto_box` de NaCl (X25519 + XSalsa20-Poly1305) a propósito: la app móvil usa
//! `tweetnacl`, que implementa exactamente la misma construcción, y los dos lados producen
//! los mismos bytes (`tests/vectors.json` lo prueba en Rust y en TypeScript).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use crypto_box::aead::{Aead, AeadCore, OsRng};
use crypto_box::{PublicKey, SalsaBox, SecretKey};

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;

/// base64url sin padding: es lo que viaja en el JSON y lo que usa `tweetnacl`-side.
pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(text: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).map_err(|_| "base64 inválido".to_string())
}

/// Una clave pública de 32 bytes a partir de su forma en texto (que es también el id).
pub fn public_key(id: &str) -> Result<[u8; KEY_LEN], String> {
    unb64(id)?.try_into().map_err(|_| "la clave tiene que tener 32 bytes".to_string())
}

/// Un par de claves X25519.
#[derive(Clone)]
pub struct Keypair {
    pub public: [u8; KEY_LEN],
    pub secret: [u8; KEY_LEN],
}

impl Keypair {
    pub fn generate() -> Self {
        Self::from_secret(SecretKey::generate(&mut OsRng).to_bytes())
    }

    pub fn from_secret(secret: [u8; KEY_LEN]) -> Self {
        let public = SecretKey::from(secret).public_key().to_bytes();
        Keypair { public, secret }
    }

    /// La identidad: la clave pública en base64url.
    pub fn id(&self) -> String {
        b64(&self.public)
    }
}

impl std::fmt::Debug for Keypair {
    // Nunca la secreta en un log.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keypair").field("public", &self.id()).finish_non_exhaustive()
    }
}

fn salsa(peer_public: &[u8; KEY_LEN], my_secret: &[u8; KEY_LEN]) -> SalsaBox {
    SalsaBox::new(&PublicKey::from(*peer_public), &SecretKey::from(*my_secret))
}

/// `nonce ‖ caja`, con un nonce aleatorio.
pub fn seal(msg: &[u8], peer_public: &[u8; KEY_LEN], my_secret: &[u8; KEY_LEN]) -> Vec<u8> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    seal_with_nonce(msg, &nonce.into(), peer_public, my_secret)
}

/// Lo mismo con un nonce elegido. Solo para los vectores de prueba: reusar un nonce con
/// el mismo par de claves rompe el cifrado.
pub fn seal_with_nonce(
    msg: &[u8],
    nonce: &[u8; NONCE_LEN],
    peer_public: &[u8; KEY_LEN],
    my_secret: &[u8; KEY_LEN],
) -> Vec<u8> {
    let sealed = salsa(peer_public, my_secret)
        .encrypt(nonce.into(), msg)
        .expect("cifrar en memoria no falla");
    let mut out = Vec::with_capacity(NONCE_LEN + sealed.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    out
}

/// Abre `nonce ‖ caja`. Falla si no la cerró el dueño de `peer_public` para nosotros, o
/// si alguien la tocó en el camino.
pub fn open(sealed: &[u8], peer_public: &[u8; KEY_LEN], my_secret: &[u8; KEY_LEN]) -> Result<Vec<u8>, String> {
    if sealed.len() < NONCE_LEN + 16 {
        return Err("mensaje demasiado corto".into());
    }
    let (nonce, body) = sealed.split_at(NONCE_LEN);
    salsa(peer_public, my_secret)
        .decrypt(nonce.into(), body)
        .map_err(|_| "no se pudo abrir el mensaje (clave equivocada o alterado)".to_string())
}

/// Bytes aleatorios del sistema (desafíos, secretos de emparejamiento).
pub fn random_bytes<const N: usize>() -> [u8; N] {
    use rand_core::RngCore;
    let mut out = [0u8; N];
    OsRng.fill_bytes(&mut out);
    out
}

/// Comparación en tiempo constante, para tokens y secretos.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
