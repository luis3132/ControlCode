//! Lo que declara un lead: un plan de tareas con dependencias, validado antes de crear nada.
//!
//! Puro. El plan llega de un modelo, así que se valida entero y **se rechaza entero**: crear
//! la mitad de las tareas y fallar en la sexta dejaría un run a medias, con tareas que
//! esperan dependencias que nunca se crearon.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::routing::Complexity;

/// Cuántas tareas puede declarar un plan de una vez. Un lead que reparte en cincuenta
/// pedazos no está planificando, está delegando el pensar.
pub const MAX_TASKS: usize = 20;

/// Hasta qué profundidad se delega: el lead (0) reparte a workers (1), que pueden repartir
/// una vez más (2). Más abajo, el costo y lo difícil de seguir crecen más que lo que se gana.
pub const MAX_DEPTH: i64 = 2;

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct PlanTask {
    /// El nombre con el que el plan se refiere a la tarea: `api`, `tests-login`.
    pub key: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub complexity: Option<Complexity>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// `None` = lo decide la app (aislada si el proyecto es un repo de git).
    #[serde(default)]
    pub isolate: Option<bool>,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// JSON Schema que tiene que cumplir el resultado.
    #[serde(default)]
    pub result_schema: Option<serde_json::Value>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 40
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Valida un plan contra las tareas que el run ya tiene (`existing`: sus claves).
///
/// Devuelve las tareas en un orden en el que cada una aparece después de sus dependencias
/// del mismo plan, que es el orden en que conviene crearlas. Los errores se juntan todos:
/// un modelo corrige mejor con la lista entera que de a uno por intento.
pub fn validate(tasks: &[PlanTask], existing: &HashSet<String>) -> Result<Vec<PlanTask>, String> {
    let mut errors = Vec::new();
    if tasks.is_empty() {
        return Err("el plan no tiene tareas".into());
    }
    if tasks.len() > MAX_TASKS {
        errors.push(format!("el plan tiene {} tareas; el máximo es {MAX_TASKS}", tasks.len()));
    }

    let mut seen = HashSet::new();
    for task in tasks {
        if !valid_key(&task.key) {
            errors.push(format!("'{}' no sirve como key: letras, números, - y _, hasta 40", task.key));
        }
        if !seen.insert(task.key.as_str()) {
            errors.push(format!("la key '{}' está repetida en el plan", task.key));
        } else if existing.contains(&task.key) {
            errors.push(format!("la key '{}' ya la usa otra tarea de este run", task.key));
        }
        if task.title.trim().is_empty() {
            errors.push(format!("'{}' no tiene título", task.key));
        }
        if task.prompt.trim().is_empty() {
            errors.push(format!("'{}' no tiene prompt", task.key));
        }
        if task.model.is_some() && task.agent.is_none() {
            errors.push(format!("'{}' nombra un modelo sin decir de qué agente", task.key));
        }
        if task.budget_usd.is_some_and(|b| b.is_nan() || b <= 0.0) {
            errors.push(format!("'{}' tiene un presupuesto que no es positivo", task.key));
        }
        for dep in &task.depends_on {
            if dep == &task.key {
                errors.push(format!("'{}' depende de sí misma", task.key));
            } else if !tasks.iter().any(|t| &t.key == dep) && !existing.contains(dep) {
                errors.push(format!("'{}' depende de '{dep}', que no existe", task.key));
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("\n"));
    }

    topological(tasks)
}

/// Orden de Kahn sobre las dependencias internas del plan. Las que apuntan a tareas que ya
/// existían no cuentan: esas ya están creadas.
fn topological(tasks: &[PlanTask]) -> Result<Vec<PlanTask>, String> {
    let keys: HashSet<&str> = tasks.iter().map(|t| t.key.as_str()).collect();
    let mut pending: HashMap<&str, usize> = tasks
        .iter()
        .map(|t| (t.key.as_str(), t.depends_on.iter().filter(|d| keys.contains(d.as_str())).count()))
        .collect();

    let mut order = Vec::with_capacity(tasks.len());
    // En el orden en que vinieron: entre dos listas a la vez, respeta el del lead.
    while order.len() < tasks.len() {
        let Some(next) = tasks.iter().find(|t| pending.get(t.key.as_str()) == Some(&0)) else {
            let mut stuck: Vec<&str> = pending.keys().copied().collect();
            stuck.sort_unstable();
            return Err(format!("el plan tiene un ciclo entre: {}", stuck.join(", ")));
        };
        pending.remove(next.key.as_str());
        for t in tasks {
            if t.depends_on.iter().any(|d| d == &next.key)
                && let Some(n) = pending.get_mut(t.key.as_str())
            {
                *n -= 1;
            }
        }
        order.push(next.clone());
    }
    Ok(order)
}
