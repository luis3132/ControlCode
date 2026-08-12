//! Tests de las TUIs que el usuario agrega a mano.

use super::custom::SessionIdSource;


#[test]
fn session_id_source_parses_both_forms() {
    assert_eq!(SessionIdSource::parse("filename"), SessionIdSource::Filename);
    assert_eq!(
        SessionIdSource::parse("field:session_id"),
        SessionIdSource::Field("session_id".to_string())
    );
    assert_eq!(SessionIdSource::parse("field: id "), SessionIdSource::Field("id".to_string()));
    // Formas inválidas caen al default en vez de romper: el descubrimiento por nombre
    // de archivo es el que funciona sin conocer nada del formato interno.
    assert_eq!(SessionIdSource::parse("field:"), SessionIdSource::Filename);
    assert_eq!(SessionIdSource::parse("cualquier cosa"), SessionIdSource::Filename);
}
