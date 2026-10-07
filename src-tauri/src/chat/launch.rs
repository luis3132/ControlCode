//! El proceso de un turno, según la plataforma. Aparte del resto porque solo depende de
//! `std` y `tokio`: así se puede compilar para Windows y macOS desde Linux.

/// Un argumento listo para ir dentro del script de un shell.
#[cfg(unix)]
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:,@+".contains(c)) {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', r"'\''"))
}

#[cfg(windows)]
pub fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || "\"&|<>^()%!,;".contains(c)) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\"\""))
}

/// El proceso a lanzar: `claude` directo o, con pasos previos, un shell que los corre y
/// termina en `claude` (como las tabs: `conda activate` es una función de shell).
pub fn command_for(program: &std::ffi::OsStr, args: &[String], prelaunch: &[String]) -> tokio::process::Command {
    if prelaunch.is_empty() {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args);
        return cmd;
    }
    let line = std::iter::once(quote(&program.to_string_lossy()))
        .chain(args.iter().map(|a| quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        let mut cmd = tokio::process::Command::new(shell);
        cmd.arg("-l").arg("-c").arg(format!("{} && exec {line}", prelaunch.join(" && ")));
        cmd
    }
    #[cfg(windows)]
    {
        // `raw_arg`: el script ya va citado para `cmd`; escaparlo otra vez con las reglas de
        // `CommandLineToArgvW` le dejaría barras y comillas de más.
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.arg("/C").raw_arg(format!("{} && {line}", prelaunch.join(" && ")));
        cmd
    }
}

