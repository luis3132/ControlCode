//! Tests de la cadena de pre-lanzamiento.

use super::*;

fn db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE prelaunch_presets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
         command TEXT NOT NULL, created_at INTEGER NOT NULL);
         INSERT INTO prelaunch_presets VALUES ('p1', 'entorno conda', 'conda activate ml', 0);
         INSERT INTO prelaunch_presets VALUES ('p2', 'node del proyecto', 'nvm use', 0);",
    )
    .unwrap();
    conn
}

/// El orden es semántico (`nvm use` antes de cualquier cosa que dependa de npm), y un
/// campo de texto que quedó en blanco no tiene por qué producir un `&&` colgando.
#[test]
fn la_cadena_conserva_el_orden_pedido_y_descarta_los_pasos_vacios() {
    let steps = vec![
        PrelaunchStep::Preset { preset_id: "p2".into() },
        PrelaunchStep::Command { command: "  ".into() },
        PrelaunchStep::Command { command: " source .venv/bin/activate ".into() },
        PrelaunchStep::Preset { preset_id: "p1".into() },
    ];
    assert_eq!(
        resolve_conn(&db(), &steps).unwrap(),
        vec!["nvm use", "source .venv/bin/activate", "conda activate ml"]
    );
}

/// Un paso que desaparece en silencio deja al agente corriendo fuera del entorno que el
/// usuario pidió — que es exactamente lo que esta feature viene a evitar.
#[test]
fn un_preset_borrado_hace_fallar_el_lanzamiento() {
    let steps = vec![PrelaunchStep::Preset { preset_id: "fantasma".into() }];
    let err = resolve_conn(&db(), &steps).unwrap_err();
    assert!(err.contains("ya no existe"), "mensaje poco claro: {err}");
}

/// El formato en disco es parte del contrato con el frontend y con `ccode`: si deja
/// de ser plano, las cadenas ya guardadas dejan de leerse.
#[test]
fn el_json_guardado_es_plano() {
    let json = steps_to_json(&[
        PrelaunchStep::Preset { preset_id: "p1".into() },
        PrelaunchStep::Command { command: "nvm use".into() },
    ]);
    assert_eq!(json, r#"[{"presetId":"p1"},{"command":"nvm use"}]"#);
}

/// Un JSON corrupto o de una versión futura se degrada a cadena vacía en vez de impedir
/// que la tab se restaure.
#[test]
fn un_json_corrupto_no_impide_restaurar_la_tab() {
    assert!(steps_from_json("{no es json").is_empty());
    assert!(steps_from_json("").is_empty());
}

#[test]
fn no_se_aceptan_presets_sin_nombre_ni_comando() {
    assert!(validate_preset("  ", "nvm use").is_err());
    assert!(validate_preset("node", "  ").is_err());
    assert!(validate_preset("node", "nvm use").is_ok());
}
