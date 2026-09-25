//! El contenido del repo de sincronización como un mapa ruta → bytes, y cómo se mezclan
//! tres versiones de él.
//!
//! ## Por qué una mezcla propia y no la de git
//!
//! Git mezcla texto por líneas: dos máquinas que cambian claves vecinas del mismo JSON
//! chocan aunque no tengan nada que ver entre sí. Acá los JSON se mezclan por clave, y los
//! demás archivos (las skills) enteros. Git queda para guardar y transportar.
//!
//! Tres versiones, como cualquier mezcla:
//!
//! - **base**: lo último que se sincronizó (el commit que esta máquina ya conoce);
//! - **local**: cómo está esta máquina ahora;
//! - **remote**: cómo está el repo ahora (puede haberlo cambiado otra máquina).
//!
//! Lo que cambió de un solo lado gana. Lo que cambiaron los dos lados de distinta forma es
//! un conflicto: gana esta máquina (es lo que el usuario tiene delante) y se informa.
//! Una modificación le gana a un borrado: perder trabajo es peor que resucitar algo.
//!
//! La excepción es la primera vez (`Winner::Remote`): una máquina que se conecta a un repo
//! que ya tiene contenido no tiene base, y con "gana esta máquina" la configuración de
//! fábrica de una instalación nueva pisaría la del usuario. Ahí gana el repo.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

pub type Tree = BTreeMap<String, Vec<u8>>;

/// Qué se resolvió solo y hay que contar.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Conflict {
    /// La ruta del archivo, y la clave adentro si es un JSON (`config/prelaunch.json#conda`).
    pub path: String,
}

/// Los archivos que se mezclan por clave. Tienen que ser objetos JSON.
pub fn is_json_doc(path: &str) -> bool {
    path.ends_with(".json") && !path.starts_with("skills/")
}

/// Un JSON como lo escribe la sincronización: claves ordenadas (el `Map` de serde_json lo
/// es) y con sangría, para que el diff del repo se lea.
pub fn json_bytes(value: &Value) -> Vec<u8> {
    let mut out = serde_json::to_vec_pretty(value).unwrap_or_default();
    out.push(b'\n');
    out
}

/// Quién gana un conflicto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Winner {
    Local,
    Remote,
}

fn merge_value(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    at: &str,
    winner: Winner,
    conflicts: &mut Vec<Conflict>,
) -> Option<Value> {
    if local == remote {
        return local.cloned();
    }
    if local == base {
        return remote.cloned();
    }
    if remote == base {
        return local.cloned();
    }
    if let (Some(Value::Object(l)), Some(Value::Object(r))) = (local, remote) {
        let empty = Map::new();
        let b = match base {
            Some(Value::Object(b)) => b,
            _ => &empty,
        };
        let keys: BTreeSet<&String> = l.keys().chain(r.keys()).chain(b.keys()).collect();
        let mut out = Map::new();
        for key in keys {
            let merged = merge_value(b.get(key), l.get(key), r.get(key), &format!("{at}/{key}"), winner, conflicts);
            if let Some(v) = merged {
                out.insert(key.clone(), v);
            }
        }
        return Some(Value::Object(out));
    }
    // Los dos lados cambiaron lo mismo. Si uno lo borró, gana el que lo modificó.
    match (local, remote) {
        (None, Some(r)) => Some(r.clone()),
        (Some(l), None) => Some(l.clone()),
        (l, r) => {
            conflicts.push(Conflict { path: at.to_string() });
            if winner == Winner::Local { l.cloned() } else { r.cloned() }
        }
    }
}

fn parse(bytes: Option<&Vec<u8>>) -> Result<Option<Value>, ()> {
    match bytes {
        None => Ok(None),
        Some(b) => serde_json::from_slice(b).map(Some).map_err(|_| ()),
    }
}

/// Mezcla las tres versiones. Devuelve el resultado y los conflictos que se resolvieron a
/// favor de esta máquina.
pub fn merge3(base: &Tree, local: &Tree, remote: &Tree, winner: Winner) -> (Tree, Vec<Conflict>) {
    let mut out = Tree::new();
    let mut conflicts = Vec::new();
    let paths: BTreeSet<&String> = base.keys().chain(local.keys()).chain(remote.keys()).collect();
    for path in paths {
        let (b, l, r) = (base.get(path), local.get(path), remote.get(path));
        // Solo los documentos de configuración se leen como JSON; un archivo de una skill
        // nunca (aunque termine en `.json`, es contenido del usuario).
        let parsed = is_json_doc(path).then(|| (parse(b), parse(l), parse(r)));
        if let Some((Ok(pb), Ok(pl), Ok(pr))) = parsed {
            let mut found = Vec::new();
            if let Some(v) = merge_value(pb.as_ref(), pl.as_ref(), pr.as_ref(), "", winner, &mut found) {
                out.insert(path.clone(), json_bytes(&v));
            }
            conflicts.extend(found.into_iter().map(|c| Conflict { path: format!("{path}#{}", c.path.trim_start_matches('/')) }));
            continue;
        }
        let merged = if l == r {
            l
        } else if l == b {
            r
        } else if r == b {
            l
        } else {
            match (l, r) {
                (None, Some(_)) => r,
                (Some(_), None) => l,
                _ => {
                    conflicts.push(Conflict { path: path.clone() });
                    if winner == Winner::Local { l } else { r }
                }
            }
        };
        if let Some(bytes) = merged {
            out.insert(path.clone(), bytes.clone());
        }
    }
    (out, conflicts)
}

/// Las carpetas de primer nivel bajo `prefix/` (las skills: `skills/<slug>/…` → `slug`).
pub fn groups(tree: &Tree, prefix: &str) -> BTreeSet<String> {
    tree.keys()
        .filter_map(|p| p.strip_prefix(prefix)?.split('/').next().map(str::to_string))
        .filter(|g| !g.is_empty())
        .collect()
}

/// Los archivos de una de esas carpetas, con la ruta relativa a ella.
pub fn group_files(tree: &Tree, prefix: &str, group: &str) -> BTreeMap<String, Vec<u8>> {
    let dir = format!("{prefix}{group}/");
    tree.iter()
        .filter_map(|(p, b)| p.strip_prefix(&dir).map(|rel| (rel.to_string(), b.clone())))
        .collect()
}

/// Un documento JSON del árbol, o un objeto vacío si no está o no se puede leer.
pub fn doc(tree: &Tree, path: &str) -> Map<String, Value> {
    tree.get(path)
        .and_then(|b| serde_json::from_slice::<Value>(b).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}
