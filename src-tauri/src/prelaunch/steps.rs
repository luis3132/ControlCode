//! La cadena de pasos: cómo se representa y cómo se guarda.

use serde::{Deserialize, Serialize};

/// Un paso de la cadena: o un preset guardado, o un comando escrito a mano.
///
/// `untagged` para que el JSON guardado sea plano —`{"presetId":"…"}` / `{"command":"…"}`—
/// en vez de llevar el nombre de la variante como envoltorio. Es lo que se escribe en la
/// base y lo que manda el frontend, así que conviene que se lea sin traducción mental.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum PrelaunchStep {
    Preset {
        #[serde(rename = "presetId")]
        preset_id: String,
    },
    Command {
        command: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrelaunchPreset {
    pub id: String,
    /// Cómo lo ve el usuario, ej. "entorno conda".
    pub name: String,
    pub command: String,
    pub created_at: i64,
}

/// Serializa la cadena para guardarla en `tabs`/`session_history`. Una cadena vacía se
/// guarda como `[]` y no como NULL, para que leerla nunca tenga que distinguir los dos.
pub fn steps_to_json(steps: &[PrelaunchStep]) -> String {
    serde_json::to_string(steps).unwrap_or_else(|_| "[]".into())
}

/// Lee la cadena guardada. Un JSON corrupto o de una versión futura se degrada a cadena
/// vacía en vez de impedir que la tab se restaure.
pub fn steps_from_json(raw: &str) -> Vec<PrelaunchStep> {
    serde_json::from_str(raw).unwrap_or_default()
}
