use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::sync::LazyLock;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Emitter;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    /// Last modification time in milliseconds since the epoch. For directories
    /// this is the most recent mtime found anywhere inside, so a folder sorts by
    /// how recently its contents changed.
    mtime: u64,
    children: Vec<FileEntry>,
}

#[derive(Serialize)]
struct McpServerInfo {
    name: String,
    source_path: String,
    source_dir: String,
    server_type: String,
    command: Option<String>,
    url: Option<String>,
    config: serde_json::Value,
}

#[derive(Serialize)]
struct McpScanResult {
    servers: Vec<McpServerInfo>,
    scan_time_ms: u64,
}

// -- Helpers compartidos -----------------------------------------------------

/// Captura un porcentaje (`42%` o `42.5%`) en lineas de progreso de git/curl.
static PERCENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)(?:\.\d+)?%").unwrap());

const CLAUDE_NOT_INSTALLED: &str =
    "Claude Code no esta instalado. Instala con: curl -fsSL https://claude.ai/install.sh | sh";

/// Ejecuta un closure bloqueante fuera del hilo async y aplana el error de join.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

/// Lee un stream de progreso (git, curl) linea por linea, separando por `\r`
/// y `\n`. Usa un buffer y decodifica UTF-8, en lugar de leer byte a byte y
/// convertir cada byte a `char` (lo que corrompia texto no ASCII).
fn for_each_progress_line(reader: impl IoRead, mut f: impl FnMut(&str)) {
    for chunk in BufReader::new(reader).split(b'\r').map_while(Result::ok) {
        for line in chunk.split(|&b| b == b'\n') {
            if !line.is_empty() {
                f(&String::from_utf8_lossy(line));
            }
        }
    }
}

/// Primer porcentaje encontrado en la linea, si existe.
fn parse_percent(line: &str) -> Option<u32> {
    PERCENT_RE.captures(line).and_then(|c| c[1].parse().ok())
}

/// Tiempo de modificacion en milisegundos desde epoch, 0 si no esta disponible.
fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Indica si la salida de git corresponde a un fallo de autenticacion.
fn is_git_auth_error(stderr: &str) -> bool {
    stderr.contains("Authentication failed")
        || stderr.contains("Permission denied")
        || stderr.contains("terminal prompts disabled")
        || stderr.contains("could not read Username")
}

/// Ejecuta git en el repositorio y devuelve stdout recortado (vacio si falla).
fn git_stdout(repo_path: &str, args: &[&str]) -> String {
    git_cmd(repo_path)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Descripcion corta de un archivo Markdown de agente/comando: el campo
/// `description:` del frontmatter YAML o, en su defecto, la primera linea util.
fn md_description(content: &str) -> String {
    fn first_text_line<'a>(mut lines: impl Iterator<Item = &'a str>) -> Option<String> {
        lines
            .find(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .map(|l| l.trim().chars().take(120).collect())
    }

    let lines: Vec<&str> = content.lines().collect();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return first_text_line(lines.into_iter()).unwrap_or_default();
    }
    let end = lines.iter().skip(1).position(|l| l.trim() == "---");
    if let Some(end_idx) = end {
        for line in &lines[1..=end_idx] {
            if let Some(desc) = line.strip_prefix("description:") {
                let d = desc.trim().trim_matches('"').trim_matches('\'');
                if !d.is_empty() {
                    return d.chars().take(120).collect();
                }
            }
        }
    }
    let skip = end.map_or(1, |i| i + 2);
    first_text_line(lines.into_iter().skip(skip)).unwrap_or_default()
}

/// Borra el archivo al salir de alcance (incluido el camino de error con `?`).
struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Escribe un archivo legible solo por el usuario actual (0600 en Unix).
fn write_private_file(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(contents.as_bytes())
}

/// Rechaza nombres que podrian escapar del directorio esperado.
fn validate_plain_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(format!("Nombre invalido: {name}"));
    }
    Ok(())
}

// -- Comandos: Vault ---------------------------------------------------------

#[tauri::command]
fn open_vault() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Seleccionar Vault")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command(async)]
fn list_vault(path: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("No es un directorio: {}", path));
    }
    Ok(build_tree(&root))
}

fn build_tree(dir: &PathBuf) -> Vec<FileEntry> {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return vec![];
    };

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();

        // Ignorar archivos/dirs ocultos
        if name.starts_with('.') {
            continue;
        }

        // file_type() no sigue symlinks: evita recursion infinita con enlaces
        // a directorios padre y ahorra un stat por entrada.
        let Ok(file_type) = entry.file_type() else { continue };
        let path = entry.path();

        if file_type.is_dir() {
            let children = build_tree(&path);
            // Roll up the newest descendant so folder ordering reflects activity
            // inside it, not just when the directory entry itself changed.
            let newest_child = children.iter().map(|c| c.mtime).max().unwrap_or(0);
            dirs.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                mtime: entry_mtime(&entry).max(newest_child),
                children,
            });
        } else if path.extension().is_some_and(|e| e == "md") {
            files.push(FileEntry {
                name: path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                mtime: entry_mtime(&entry),
                children: vec![],
            });
        }
    }

    // Name order is the default; the sidebar re-sorts client-side so changing
    // the order does not require re-reading the vault.
    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.extend(files);
    dirs
}

/// Modification time of a directory entry in milliseconds, 0 when unavailable.
fn entry_mtime(entry: &fs::DirEntry) -> u64 {
    entry.metadata().map_or(0, |m| mtime_ms(&m))
}

// -- Comandos: Notas ---------------------------------------------------------

#[tauri::command(async)]
fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn save_note(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| e.to_string())
}

/// Forward a frontend log line to stderr.
///
/// WebKitGTK does not surface `console.*` or uncaught errors to the terminal,
/// which made frontend failures invisible outside the inspector. The frontend
/// installs error handlers that call this so `npm run dev` shows them.
#[tauri::command]
fn log_frontend(level: String, message: String) {
    eprintln!("[frontend/{}] {}", level, message);
}

/// Note to open automatically at startup, from POTATO_DIAG_NOTE.
///
/// Debug affordance for reproducing load problems on a specific file without
/// having to click through the UI.
#[tauri::command]
fn diag_note_path() -> Option<String> {
    std::env::var("POTATO_DIAG_NOTE").ok().filter(|v| !v.is_empty())
}

#[derive(Serialize)]
struct NoteStat {
    size: u64,
    /// Modification time in milliseconds since the epoch.
    mtime: u64,
}

/// Cheap change probe for a note.
///
/// External-change detection used to read the whole file back and compare it as
/// a string, which on a multi-megabyte note ran on every window focus. Size and
/// mtime answer the same question without touching the contents.
#[tauri::command]
fn note_stat(path: String) -> Result<NoteStat, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(NoteStat {
        size: meta.len(),
        mtime: mtime_ms(&meta),
    })
}

#[tauri::command]
fn create_note(vault_path: String, name: String) -> Result<String, String> {
    use std::io::Write;
    validate_plain_name(&name)?;
    let file_path = PathBuf::from(&vault_path).join(format!("{name}.md"));
    // create_new evita sobrescribir en silencio una nota existente.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .map_err(|e| e.to_string())?;
    file.write_all(format!("# {name}\n\n").as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().into_owned())
}

// -- Comandos: Git -----------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct GitStatus {
    is_repo: bool,
    has_changes: bool,
    branch: String,
    remote: String,
}

/// Helper: crea un Command de git que no se cuelga esperando autenticacion.
/// GIT_TERMINAL_PROMPT=0 evita prompts HTTPS.
/// SSH BatchMode=yes evita prompts de passphrase SSH.
/// LC_ALL=C fuerza mensajes en ingles: el parseo de progreso y errores busca
/// cadenas en ingles y fallaba en sistemas con locale en espanol.
fn git_cmd(repo_path: &str) -> std::process::Command {
    let mut cmd = git_cmd_bare();
    cmd.args(["-C", repo_path]);
    cmd
}

/// Helper: git command sin -C (para clone)
fn git_cmd_bare() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
    cmd.env("LC_ALL", "C");
    cmd
}

/// Evento de progreso compartido por clonado (git) y descarga de updates.
#[derive(Serialize, Clone)]
struct Progress {
    phase: String,
    percent: u32,
}

#[tauri::command]
async fn git_clone(app: tauri::AppHandle, url: String, path: String) -> Result<String, String> {
    run_blocking(move || {
        // "--" impide que una URL que empiece con "-" se interprete como opcion
        // (p. ej. --upload-pack=<cmd>).
        let mut child = git_cmd_bare()
            .args(["clone", "--progress", "--", &url, &path])
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar git: {e}"))?;

        // git usa \r para actualizar la linea de progreso
        if let Some(stderr) = child.stderr.take() {
            for_each_progress_line(stderr, |line| {
                let phase = if line.contains("Counting") {
                    "Contando objetos"
                } else if line.contains("Compressing") {
                    "Comprimiendo"
                } else if line.contains("Receiving") {
                    "Recibiendo objetos"
                } else if line.contains("Resolving") {
                    "Resolviendo deltas"
                } else if line.contains("Cloning") {
                    "Conectando"
                } else {
                    return;
                };

                let percent = parse_percent(line).unwrap_or(0);

                // Mapear fases a progreso global
                let overall = match phase {
                    "Conectando" => 2,
                    "Contando objetos" => 5 + percent / 10,
                    "Comprimiendo" => 15 + percent / 5,
                    "Recibiendo objetos" => 35 + percent / 2,
                    "Resolviendo deltas" => 85 + percent * 15 / 100,
                    _ => percent,
                };

                let _ = app.emit("git-progress", Progress {
                    phase: phase.to_string(),
                    percent: overall.min(100),
                });
            });
        }

        let status = child.wait().map_err(|e| format!("Error esperando git: {e}"))?;

        let _ = app.emit("git-progress", Progress {
            phase: "Completado".to_string(),
            percent: 100,
        });

        if status.success() {
            Ok(path)
        } else {
            Err("Error al clonar. Verifica la URL y tu autenticacion (SSH o HTTPS).".to_string())
        }
    })
    .await
}

#[tauri::command]
async fn git_status(path: String) -> Result<GitStatus, String> {
    run_blocking(move || {
        // Check if it's a git repo
        let is_repo = git_cmd(&path)
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !is_repo {
            return Ok(GitStatus {
                is_repo: false,
                has_changes: false,
                branch: String::new(),
                remote: String::new(),
            });
        }

        let branch = git_stdout(&path, &["branch", "--show-current"]);
        let remote = git_stdout(&path, &["remote", "get-url", "origin"]);

        let has_changes = git_cmd(&path)
            .args(["status", "--porcelain"])
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);

        Ok(GitStatus {
            is_repo,
            has_changes,
            branch,
            remote,
        })
    })
    .await
}

#[derive(Serialize, Clone)]
pub struct GitFileChange {
    path: String,
    status: String,       // "modified", "new", "deleted", "renamed"
    status_code: String,  // "M", "?", "D", "R", "A"
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String, String> {
    run_blocking(move || {
        let pull = git_cmd(&path)
            .args(["pull", "--rebase", "--autostash"])
            .output()
            .map_err(|e| format!("Error en pull: {}", e))?;

        if pull.status.success() {
            let stdout = String::from_utf8_lossy(&pull.stdout).trim().to_string();
            if stdout.contains("Already up to date") || stdout.contains("Current branch") {
                Ok("already_up_to_date".to_string())
            } else {
                Ok(stdout)
            }
        } else {
            let stderr = String::from_utf8_lossy(&pull.stderr).to_string();
            if stderr.contains("no tracking information") || stderr.contains("no such ref") {
                Ok("no_remote_branch".to_string())
            } else if is_git_auth_error(&stderr) {
                Err("auth_error".to_string())
            } else {
                Err(stderr)
            }
        }
    })
    .await
}

#[derive(Serialize)]
struct ShareLink {
    /// Web URL that renders the note, empty when the host is unsupported.
    url: String,
    /// "github" | "gitlab" | "none" (no repo/remote) | "unsupported" (unknown host)
    provider: String,
    /// Note path relative to the vault root, always filled.
    relative_path: String,
    branch: String,
    /// "synced" | "uncommitted" | "unpushed" | "unknown"
    sync_state: String,
}

/// Convert a git remote URL into its web base URL.
/// Handles `git@host:org/repo.git`, `ssh://git@host/org/repo.git` and
/// `https://host/org/repo.git`. Returns (base_url, provider).
fn remote_to_web_base(remote: &str) -> (String, String) {
    let remote = remote.trim();
    if remote.is_empty() {
        return (String::new(), "none".to_string());
    }

    // Normalize to "host/org/repo"
    let stripped = if let Some(rest) = remote.strip_prefix("git@") {
        // git@github.com:org/repo.git
        rest.replacen(':', "/", 1)
    } else if let Some(rest) = remote.strip_prefix("ssh://") {
        rest.trim_start_matches("git@").to_string()
    } else if let Some(rest) = remote.strip_prefix("https://") {
        rest.to_string()
    } else if let Some(rest) = remote.strip_prefix("http://") {
        rest.to_string()
    } else {
        return (String::new(), "unsupported".to_string());
    };

    // Drop credentials in https://user:token@host/... and the trailing .git
    let stripped = match stripped.split_once('@') {
        Some((_, rest)) => rest.to_string(),
        None => stripped,
    };
    let stripped = stripped.trim_end_matches('/');
    let stripped = stripped.strip_suffix(".git").unwrap_or(stripped);

    let host = stripped.split('/').next().unwrap_or("");
    // Strip an explicit port (host:22/org/repo)
    let host_no_port = host.split(':').next().unwrap_or(host);

    let provider = if host_no_port == "github.com" {
        "github"
    } else if host_no_port.contains("gitlab") {
        "gitlab"
    } else {
        return (String::new(), "unsupported".to_string());
    };

    let path = stripped.strip_prefix(host).unwrap_or("").trim_start_matches('/');
    if path.is_empty() {
        return (String::new(), "unsupported".to_string());
    }

    (
        format!("https://{}/{}", host_no_port, path),
        provider.to_string(),
    )
}

/// Percent-encode a path for use inside a URL, keeping `/` separators intact.
fn encode_url_path(path: &str) -> String {
    let unreserved = |c: u8| {
        c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~' | b'/')
    };
    let mut out = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        if unreserved(*byte) {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

/// Build a shareable web link for a note inside a git-backed vault.
#[tauri::command]
async fn git_share_link(vault_path: String, note_path: String) -> Result<ShareLink, String> {
    run_blocking(move || {
        // Note path relative to the vault root (this is the fallback payload
        // when the vault has no usable remote).
        let relative_path = note_path
            .strip_prefix(&vault_path)
            .unwrap_or(&note_path)
            .trim_start_matches('/')
            .to_string();

        let empty = ShareLink {
            url: String::new(),
            provider: "none".to_string(),
            relative_path: relative_path.clone(),
            branch: String::new(),
            sync_state: "unknown".to_string(),
        };

        if !std::path::Path::new(&vault_path).join(".git").exists() {
            return Ok(empty);
        }

        let remote = git_stdout(&vault_path, &["remote", "get-url", "origin"]);

        let (base, provider) = remote_to_web_base(&remote);
        if base.is_empty() {
            return Ok(ShareLink { provider, ..empty });
        }

        let branch = git_stdout(&vault_path, &["rev-parse", "--abbrev-ref", "HEAD"]);

        // Detached HEAD: link the commit sha so the URL still resolves.
        let git_ref = if branch.is_empty() || branch == "HEAD" {
            git_stdout(&vault_path, &["rev-parse", "HEAD"])
        } else {
            branch.clone()
        };

        if git_ref.is_empty() {
            return Ok(ShareLink { provider, ..empty });
        }

        // GitHub and GitLab differ in their blob path.
        let url = if provider == "gitlab" {
            format!(
                "{}/-/blob/{}/{}",
                base,
                encode_url_path(&git_ref),
                encode_url_path(&relative_path)
            )
        } else {
            format!(
                "{}/blob/{}/{}",
                base,
                encode_url_path(&git_ref),
                encode_url_path(&relative_path)
            )
        };

        // Sync state for THIS note: uncommitted work first, then unpushed commits.
        let dirty = git_cmd(&vault_path)
            .args(["status", "--porcelain", "--", &relative_path])
            .output()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);

        let sync_state = if dirty {
            "uncommitted".to_string()
        } else {
            let unpushed = git_cmd(&vault_path)
                .args(["rev-list", "--count", "@{u}..HEAD", "--", &relative_path])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .trim()
                        .parse::<u32>()
                        .unwrap_or(0)
                });
            match unpushed {
                Some(0) => "synced".to_string(),
                Some(_) => "unpushed".to_string(),
                // No upstream configured -> we cannot tell.
                None => "unknown".to_string(),
            }
        };

        Ok(ShareLink {
            url,
            provider,
            relative_path,
            branch: git_ref,
            sync_state,
        })
    })
    .await
}

#[cfg(test)]
mod share_link_tests {
    use super::{encode_url_path, remote_to_web_base};

    #[test]
    fn parses_ssh_scp_remote() {
        let (base, provider) = remote_to_web_base("git@github.com:JemXiaolong/Potato.git");
        assert_eq!(base, "https://github.com/JemXiaolong/Potato");
        assert_eq!(provider, "github");
    }

    #[test]
    fn parses_ssh_url_remote() {
        let (base, provider) = remote_to_web_base("ssh://git@github.com/org/repo.git");
        assert_eq!(base, "https://github.com/org/repo");
        assert_eq!(provider, "github");
    }

    #[test]
    fn parses_https_remote_with_credentials() {
        let (base, provider) = remote_to_web_base("https://user:token@github.com/org/repo.git");
        assert_eq!(base, "https://github.com/org/repo");
        assert_eq!(provider, "github");
    }

    #[test]
    fn parses_gitlab_subgroups() {
        let (base, provider) = remote_to_web_base("git@gitlab.com:group/sub/repo.git");
        assert_eq!(base, "https://gitlab.com/group/sub/repo");
        assert_eq!(provider, "gitlab");
    }

    #[test]
    fn rejects_unknown_hosts_and_empty_remotes() {
        assert_eq!(remote_to_web_base("").1, "none");
        assert_eq!(remote_to_web_base("git@bitbucket.org:org/repo.git").1, "unsupported");
        assert_eq!(remote_to_web_base("/srv/git/repo.git").1, "unsupported");
    }

    #[test]
    fn keeps_repo_names_ending_in_git() {
        let (base, _) = remote_to_web_base("git@github.com:org/config.git.git");
        assert_eq!(base, "https://github.com/org/config.git");
    }

    #[test]
    fn encodes_spaces_and_accents_but_not_separators() {
        assert_eq!(
            encode_url_path("notas/mi nota.md"),
            "notas/mi%20nota.md"
        );
        assert_eq!(encode_url_path("año.md"), "a%C3%B1o.md");
    }
}

#[tauri::command]
async fn git_changed_files(path: String) -> Result<Vec<GitFileChange>, String> {
    run_blocking(move || {
        let output = git_cmd(&path)
            // core.quotePath=false: no escapar rutas con acentos (año.md llegaba
            // como "a\303\261o.md" y luego fallaba el git add).
            .args(["-c", "core.quotePath=false", "status", "--porcelain"])
            .output()
            .map_err(|e| format!("Error en status: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut files = Vec::new();

        for line in stdout.lines() {
            if line.len() < 3 {
                continue;
            }
            let code = line[..2].trim().to_string();
            // En renombres git imprime "viejo -> nuevo"; interesa la ruta nueva.
            let raw = &line[3..];
            let raw = raw.rsplit_once(" -> ").map_or(raw, |(_, new)| new);
            let file_path = raw.trim_matches('"').to_string();

            let (status, status_code) = match code.as_str() {
                "M" | "MM" => ("modified".to_string(), "M".to_string()),
                "A" | "AM" => ("new (staged)".to_string(), "A".to_string()),
                "??" => ("new".to_string(), "?".to_string()),
                "D" => ("deleted".to_string(), "D".to_string()),
                "R" | "RM" => ("renamed".to_string(), "R".to_string()),
                "C" => ("copied".to_string(), "C".to_string()),
                _ => (format!("changed ({})", code), code.clone()),
            };

            files.push(GitFileChange {
                path: file_path,
                status,
                status_code,
            });
        }

        Ok(files)
    })
    .await
}

#[tauri::command]
async fn git_stage_files(path: String, files: Vec<String>) -> Result<(), String> {
    run_blocking(move || {
        let mut args = vec!["add", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs);

        let output = git_cmd(&path)
            .args(&args)
            .output()
            .map_err(|e| format!("Error en git add: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(format!("Error en git add: {}", String::from_utf8_lossy(&output.stderr)))
        }
    })
    .await
}

#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<String, String> {
    run_blocking(move || {
        let output = git_cmd(&path)
            .args(["commit", "-m", &message])
            .output()
            .map_err(|e| format!("Error en commit: {}", e))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(format!("Error en commit: {}", String::from_utf8_lossy(&output.stderr)))
        }
    })
    .await
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    run_blocking(move || {
        let output = git_cmd(&path)
            .args(["push", "-u", "origin", "HEAD"])
            .output()
            .map_err(|e| format!("Error en push: {}", e))?;

        if output.status.success() {
            Ok("Push OK".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if is_git_auth_error(&stderr) {
                Err("auth_error".to_string())
            } else {
                Err(stderr)
            }
        }
    })
    .await
}

#[tauri::command]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Elegir carpeta destino")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

// -- Comandos: Export PDF ----------------------------------------------------

/// Ask the user where to save the exported PDF.
#[tauri::command]
fn pick_pdf_path(default_name: String) -> Option<String> {
    let safe_name = if default_name.trim().is_empty() {
        "nota.pdf".to_string()
    } else {
        default_name
    };
    rfd::FileDialog::new()
        .set_title("Guardar PDF")
        .set_file_name(&safe_name)
        .add_filter("PDF", &["pdf"])
        .save_file()
        .map(|p| {
            let mut p = p;
            if p.extension().is_none() {
                p.set_extension("pdf");
            }
            p.to_string_lossy().to_string()
        })
}

/// Export the current webview contents to a PDF file.
///
/// This drives WebKit's own print operation rather than an external converter,
/// so the PDF is laid out by the same engine that renders the preview and needs
/// no extra runtime dependency (chromium, wkhtmltopdf). What gets printed is
/// controlled entirely by the `@media print` stylesheet.
#[cfg(target_os = "linux")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, output_path: String) -> Result<String, String> {
    use std::sync::mpsc;
    use std::time::Duration;

    // GTK writes to a URI, not a bare path.
    let path_buf = PathBuf::from(&output_path);
    if let Some(parent) = path_buf.parent() {
        if !parent.exists() {
            return Err(format!("La carpeta destino no existe: {}", parent.display()));
        }
    }
    let uri = format!("file://{}", output_path);
    let result_path = output_path.clone();

    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |webview| {
            use webkit2gtk::{PrintOperation, PrintOperationExt};

            let settings = gtk::PrintSettings::new();
            // The "Print to File" backend is what turns a print job into a PDF.
            settings.set_printer("Print to File");
            settings.set(gtk::PRINT_SETTINGS_OUTPUT_URI.as_str(), Some(uri.as_str()));
            settings.set(
                gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT.as_str(),
                Some("pdf"),
            );

            // A4 with margins wide enough for the watermark to sit clear of text.
            let page_setup = gtk::PageSetup::new();
            page_setup.set_paper_size(&gtk::PaperSize::new(Some("iso_a4")));
            page_setup.set_orientation(gtk::PageOrientation::Portrait);
            page_setup.set_top_margin(12.0, gtk::Unit::Mm);
            page_setup.set_bottom_margin(12.0, gtk::Unit::Mm);
            page_setup.set_left_margin(14.0, gtk::Unit::Mm);
            page_setup.set_right_margin(14.0, gtk::Unit::Mm);

            let operation = PrintOperation::new(&webview.inner());
            operation.set_print_settings(&settings);
            operation.set_page_setup(&page_setup);

            let tx_done = tx.clone();
            operation.connect_finished(move |_| {
                let _ = tx_done.send(Ok(()));
            });
            let tx_fail = tx.clone();
            operation.connect_failed(move |_, err| {
                let _ = tx_fail.send(Err(err.to_string()));
            });

            operation.print();

            // print() returns immediately and the job continues on the GTK main
            // loop. Dropping the operation here would cancel it, so the handle
            // is deliberately leaked; it is freed when the process exits.
            std::mem::forget(operation);
        })
        .map_err(|e| format!("No se pudo acceder al webview: {}", e))?;

    // Large notes take a while to paginate, hence the generous ceiling.
    match rx.recv_timeout(Duration::from_secs(180)) {
        Ok(Ok(())) => {
            if PathBuf::from(&result_path).exists() {
                Ok(result_path)
            } else {
                Err("La impresion termino pero no se genero el archivo".to_string())
            }
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("La exportacion excedio el tiempo limite".to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
async fn export_pdf(
    _window: tauri::WebviewWindow,
    _output_path: String,
) -> Result<String, String> {
    Err("La exportacion a PDF solo esta implementada en Linux".to_string())
}

// -- Comandos: Search --------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct SearchResult {
    path: String,
    name: String,
    match_type: String,  // "name" or "content"
    preview: String,     // snippet with context
    line: u32,           // line number (0 for name matches)
}

#[tauri::command]
async fn search_vault(path: String, query: String) -> Result<Vec<SearchResult>, String> {
    run_blocking(move || {
        let query_lower = query.to_lowercase();
        let mut results = Vec::new();
        search_dir(&PathBuf::from(&path), &query_lower, &mut results);
        // Name matches first, then content matches
        results.sort_by(|a, b| {
            let type_ord = if a.match_type == "name" { 0u8 } else { 1 };
            let type_ord_b = if b.match_type == "name" { 0u8 } else { 1 };
            type_ord.cmp(&type_ord_b).then(a.name.cmp(&b.name))
        });
        // Limit results
        results.truncate(50);
        Ok(results)
    })
    .await
}

fn search_dir(dir: &PathBuf, query: &str, results: &mut Vec<SearchResult>) {
    let Ok(read_dir) = fs::read_dir(dir) else { return };

    for entry in read_dir.flatten() {
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        let Ok(file_type) = entry.file_type() else { continue };
        let path = entry.path();

        if file_type.is_dir() {
            search_dir(&path, query, results);
        } else if path.extension().is_some_and(|e| e == "md") {
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().into_owned();
            let path_str = path.to_string_lossy().into_owned();

            // Match file name
            if stem.to_lowercase().contains(query) {
                results.push(SearchResult {
                    path: path_str.clone(),
                    name: stem.clone(),
                    match_type: "name".to_string(),
                    preview: String::new(),
                    line: 0,
                });
            }

            // Match content
            // Maximo 3 coincidencias de contenido por archivo. Antes se recontaban
            // todos los resultados acumulados en cada coincidencia (O(n^2)).
            if let Ok(content) = fs::read_to_string(&path) {
                let matches = content
                    .lines()
                    .enumerate()
                    .filter(|(_, l)| l.to_lowercase().contains(query))
                    .take(3);
                for (i, line_text) in matches {
                    results.push(SearchResult {
                        path: path_str.clone(),
                        name: stem.clone(),
                        match_type: "content".to_string(),
                        preview: line_text.trim().chars().take(120).collect(),
                        line: u32::try_from(i + 1).unwrap_or(u32::MAX),
                    });
                }
            }
        }
    }
}

// -- Comandos: Session -------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    vault_path: Option<String>,
    note_path: Option<String>,
    note_title: Option<String>,
}

fn session_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config"));
    config_dir.join("potato")
}

#[tauri::command]
fn save_session(vault_path: Option<String>, note_path: Option<String>, note_title: Option<String>) -> Result<(), String> {
    let dir = session_path();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let session = Session { vault_path, note_path, note_title };
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    fs::write(dir.join("session.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_session() -> Option<Session> {
    let path = session_path().join("session.json");
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

// -- Comandos: Archivos ------------------------------------------------------

#[tauri::command(async)]
fn move_file(from: String, to_dir: String) -> Result<String, String> {
    let from_path = PathBuf::from(&from);

    if !from_path.exists() {
        return Err(format!("El archivo no existe: {}", from));
    }

    let file_name = from_path
        .file_name()
        .ok_or("No se pudo obtener el nombre del archivo")?
        .to_string_lossy()
        .to_string();

    let dest_dir = PathBuf::from(&to_dir);
    if !dest_dir.is_dir() {
        return Err(format!("La carpeta destino no existe: {}", to_dir));
    }

    let dest_path = dest_dir.join(&file_name);

    if dest_path.exists() {
        return Err(format!("Ya existe '{}' en la carpeta destino", file_name));
    }

    fs::rename(&from_path, &dest_path)
        .map_err(|e| format!("Error al mover archivo: {}", e))?;

    Ok(dest_path.to_string_lossy().to_string())
}

// -- Comandos: Sistema -------------------------------------------------------

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// -- MCP: Escanear servidores ------------------------------------------------

#[tauri::command]
async fn scan_mcp_servers() -> Result<McpScanResult, String> {
    run_blocking(|| {
        let home = std::env::var("HOME").unwrap_or_default();
        if home.is_empty() {
            return Ok(McpScanResult { servers: vec![], scan_time_ms: 0 });
        }

        let start = std::time::Instant::now();
        const EXCLUDE_DIRS: &[&str] = &[
            "node_modules", "target", "__pycache__", "venv", "dist", "build", "snap",
        ];

        let mut servers = Vec::new();

        for entry in WalkDir::new(&home)
            .max_depth(6)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                if e.file_type().is_dir() {
                    let name = e.file_name().to_string_lossy();
                    // Permitir el home dir raiz
                    if e.depth() == 0 { return true; }
                    // Excluir directorios ocultos (.git, .cache, .venv, ...)
                    !name.starts_with('.') && !EXCLUDE_DIRS.contains(&name.as_ref())
                } else {
                    true
                }
            })
        {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            if !entry.file_type().is_file() {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy();
            if file_name != ".mcp.json" {
                continue;
            }

            let path = entry.path();
            let source_path = path.to_string_lossy().to_string();
            let source_dir = path.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let content = match fs::read_to_string(path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let parsed: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let mcp_servers = match parsed.get("mcpServers").and_then(|v| v.as_object()) {
                Some(obj) => obj,
                None => continue,
            };

            for (name, config) in mcp_servers {
                let server_type = config.get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("stdio")
                    .to_string();

                let command = config.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| {
                        let mut parts = vec![c.to_string()];
                        if let Some(args) = config.get("args").and_then(|a| a.as_array()) {
                            for arg in args {
                                if let Some(s) = arg.as_str() {
                                    parts.push(s.to_string());
                                }
                            }
                        }
                        parts.join(" ")
                    });

                let url = config.get("url")
                    .and_then(|u| u.as_str())
                    .map(|u| u.to_string());

                servers.push(McpServerInfo {
                    name: name.clone(),
                    source_path: source_path.clone(),
                    source_dir: source_dir.clone(),
                    server_type,
                    command,
                    url,
                    config: config.clone(),
                });
            }
        }

        let elapsed = start.elapsed().as_millis() as u64;
        Ok(McpScanResult { servers, scan_time_ms: elapsed })
    })
    .await
}

// -- Claude: Listar agentes --------------------------------------------------

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    name: String,
    description: String,
}

#[tauri::command(async)]
fn list_claude_agents(path: String) -> Vec<AgentInfo> {
    let agents_dir = PathBuf::from(&path).join(".claude").join("agents");
    if !agents_dir.is_dir() {
        return vec![];
    }

    let Ok(read_dir) = fs::read_dir(&agents_dir) else {
        return vec![];
    };

    let mut agents = Vec::new();
    for entry in read_dir.flatten() {
        let file_path = entry.path();
        if file_path.extension().is_some_and(|e| e == "md") {
            let name = file_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            // Leer descripcion del frontmatter YAML o primera linea util
            let description = fs::read_to_string(&file_path)
                .map(|c| md_description(&c))
                .unwrap_or_default();

            agents.push(AgentInfo { name, description });
        }
    }

    agents.sort_by(|a, b| a.name.cmp(&b.name));
    agents
}

// -- Claude: Structs ---------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct UsageInfo {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Serialize, Clone)]
pub struct ToolActivity {
    pub tool_name: String,
    pub tool_id: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct StreamChunk {
    pub content: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<UsageInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolActivity>,
}

// -- Claude: Process registry ------------------------------------------------

/// Id de sesion (frontend) -> PID del proceso `claude`.
static CLAUDE_REGISTRY: LazyLock<Mutex<HashMap<String, u32>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn claude_registry<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, u32>) -> R,
{
    // Un panic con el lock tomado no debe inutilizar todas las sesiones.
    let mut guard = CLAUDE_REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut guard)
}

fn claude_register(id: &str, pid: u32) {
    claude_registry(|map| {
        map.insert(id.to_string(), pid);
    });
}

fn claude_unregister(id: &str) {
    claude_registry(|map| {
        map.remove(id);
    });
}

fn claude_stop(id: &str) -> Result<(), String> {
    let pid = claude_registry(|map| map.remove(id));
    match pid {
        Some(p) => {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &p.to_string()])
                .output();
            Ok(())
        }
        None => Err("No hay proceso activo para esa sesion".to_string()),
    }
}

// -- Claude: Listar comandos -------------------------------------------------

#[tauri::command(async)]
fn list_claude_commands(path: String) -> Vec<AgentInfo> {
    // Aceptar tanto el directorio raiz como la ruta completa a .claude/commands
    let base = PathBuf::from(&path);
    let commands_dir = if base.ends_with(".claude/commands") || base.ends_with(".claude\\commands") {
        base
    } else if base.join("commands").is_dir() && base.ends_with(".claude") {
        base.join("commands")
    } else {
        base.join(".claude").join("commands")
    };
    if !commands_dir.is_dir() {
        return vec![];
    }

    let Ok(read_dir) = fs::read_dir(&commands_dir) else {
        return vec![];
    };

    let mut commands = Vec::new();
    for entry in read_dir.flatten() {
        let file_path = entry.path();
        // Resolver symlinks
        let resolved = fs::canonicalize(&file_path).unwrap_or(file_path.clone());
        if resolved.extension().is_some_and(|e| e == "md") {
            let name = file_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let description = fs::read_to_string(&resolved)
                .map(|c| md_description(&c))
                .unwrap_or_default();

            commands.push(AgentInfo { name, description });
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

#[tauri::command(async)]
fn read_claude_command(path: String, command: String) -> Result<String, String> {
    let base = PathBuf::from(&path);
    let commands_dir = if base.ends_with(".claude/commands") || base.ends_with(".claude\\commands") {
        base
    } else if base.join("commands").is_dir() && base.ends_with(".claude") {
        base.join("commands")
    } else {
        base.join(".claude").join("commands")
    };
    validate_plain_name(&command)?;
    let cmd_file = commands_dir.join(format!("{command}.md"));
    let resolved = fs::canonicalize(&cmd_file).map_err(|e| e.to_string())?;
    fs::read_to_string(&resolved).map_err(|e| e.to_string())
}

// -- Claude: Resolver binario ------------------------------------------------

static CLAUDE_BINARY: Mutex<Option<String>> = Mutex::new(None);

/// Intenta encontrar el binario de `claude` en el sistema.
/// Primero usa un login shell para obtener el PATH completo del usuario,
/// luego busca en rutas comunes de npm/nvm/fnm.
fn resolve_claude_binary() -> Option<String> {
    // 1. Intentar con login shell (hereda .bashrc/.zshrc/.profile)
    let shells = ["bash", "zsh", "sh"];
    for shell in &shells {
        if let Ok(output) = std::process::Command::new(shell)
            .args(["-lc", "which claude"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() && PathBuf::from(&path).exists() {
                    return Some(path);
                }
            }
        }
    }

    // 2. Buscar en rutas comunes
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return None;
    }

    let candidates = [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.npm-global/bin/claude"),
        "/usr/local/bin/claude".to_string(),
        "/usr/bin/claude".to_string(),
    ];

    for path in &candidates {
        if PathBuf::from(path).exists() {
            return Some(path.clone());
        }
    }

    // 3. Buscar en nvm
    let nvm_dir = PathBuf::from(&home).join(".nvm").join("versions").join("node");
    if nvm_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&nvm_dir) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin").join("claude");
                if bin.exists() {
                    return Some(bin.to_string_lossy().to_string());
                }
            }
        }
    }

    // 4. Buscar en fnm
    let fnm_dirs = [
        PathBuf::from(&home).join(".fnm").join("node-versions"),
        PathBuf::from(&home).join(".local").join("share").join("fnm").join("node-versions"),
    ];
    for fnm_dir in &fnm_dirs {
        if fnm_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(fnm_dir) {
                for entry in entries.flatten() {
                    let bin = entry.path().join("installation").join("bin").join("claude");
                    if bin.exists() {
                        return Some(bin.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    // 5. Buscar en ~/.local/share/claude/versions/ (instalacion via curl)
    let claude_share = PathBuf::from(&home).join(".local/share/claude/versions");
    if claude_share.is_dir() {
        if let Ok(entries) = fs::read_dir(&claude_share) {
            let mut best: Option<(String, String)> = None;
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if best.as_ref().is_none_or(|(b, _)| name > *b) {
                        best = Some((name, p.to_string_lossy().to_string()));
                    }
                }
            }
            if let Some((_, path)) = best {
                return Some(path);
            }
        }
    }

    None
}

/// Devuelve la ruta al binario de claude, cacheada tras la primera resolucion.
fn get_claude_binary() -> Result<String, String> {
    let lock = || CLAUDE_BINARY.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(path) = lock().clone() {
        return Ok(path);
    }

    // La resolucion lanza login shells (lenta): no mantener el lock mientras tanto.
    let path = resolve_claude_binary().ok_or_else(|| CLAUDE_NOT_INSTALLED.to_string())?;
    *lock() = Some(path.clone());
    Ok(path)
}

// -- Claude: Comandos --------------------------------------------------------

#[tauri::command(async)]
fn check_claude() -> Result<String, String> {
    let binary = get_claude_binary()?;
    let output = std::process::Command::new(&binary)
        .arg("--version")
        .output()
        .map_err(|_| CLAUDE_NOT_INSTALLED.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(CLAUDE_NOT_INSTALLED.to_string())
    }
}

// Cada argumento corresponde a un campo que envia el frontend en invoke().
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn send_claude_message(
    message: String,
    process_id: String,
    session_id: Option<String>,
    model: Option<String>,
    working_dir: Option<String>,
    allowed_tools: Option<Vec<String>>,
    system_prompt: Option<String>,
    mcp_config_json: Option<String>,
    on_event: Channel<StreamChunk>,
) -> Result<String, String> {
    // process_id se usa en el nombre del archivo temporal: evitar "../" etc.
    if !process_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("process_id invalido".to_string());
    }
    run_blocking(move || {
        let mut args: Vec<String> = vec![
            "--print".to_string(),
            "--verbose".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--include-partial-messages".to_string(),
        ];

        // MCP config: escribir a archivo temporal y pasar la ruta
        // Colocar ANTES de --dangerously-skip-permissions para que ese flag
        // termine la coleccion variadic de --mcp-config
        // El archivo puede contener tokens: se crea con permisos 0600 y se borra
        // al salir de la funcion (TempFileGuard), incluso si algo falla despues.
        let _mcp_temp_file: Option<TempFileGuard> = if let Some(ref mcp_json) = mcp_config_json {
            let tmp_path = std::env::temp_dir().join(format!("potato-mcp-{process_id}.json"));
            write_private_file(&tmp_path, mcp_json)
                .map_err(|e| format!("Error escribiendo MCP config: {e}"))?;
            args.push("--mcp-config".to_string());
            args.push(tmp_path.to_string_lossy().into_owned());
            Some(TempFileGuard(tmp_path))
        } else {
            None
        };

        args.push("--dangerously-skip-permissions".to_string());

        if let Some(ref sid) = session_id {
            args.push("--resume".to_string());
            args.push(sid.clone());
        }

        if let Some(ref m) = model {
            args.push("--model".to_string());
            args.push(m.clone());
        }

        // System prompt para restricciones de modo
        if let Some(ref sp) = system_prompt {
            args.push("--append-system-prompt".to_string());
            args.push(sp.clone());
        }

        // Linux caps a single argv entry at MAX_ARG_STRLEN (128 KiB). The prompt
        // carries the whole open note as context, so any sizeable note made the
        // spawn fail outright with E2BIG. Large prompts go through stdin, which
        // has no such limit. Small prompts keep using argv so the common path
        // behaves exactly as before.
        const ARGV_PROMPT_LIMIT: usize = 64 * 1024;
        let prompt_via_stdin = message.len() > ARGV_PROMPT_LIMIT;
        if !prompt_via_stdin {
            args.push(message.clone());
        }

        let binary = get_claude_binary()
            .map_err(|e| format!("No se encontro claude: {}", e))?;

        let mut cmd = std::process::Command::new(&binary);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if prompt_via_stdin {
            cmd.stdin(Stdio::piped());
        }

        if let Some(ref dir) = working_dir {
            if std::path::Path::new(dir).is_dir() {
                cmd.current_dir(dir);
            }
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| {
                let bin_exists = std::path::Path::new(&binary).exists();
                let dir_info = working_dir.as_deref().unwrap_or("(none)");
                let dir_exists = working_dir.as_ref().is_none_or(|d| std::path::Path::new(d).is_dir());
                format!(
                    "No se pudo ejecutar claude: {} | binary={} (exists={}) | workdir={} (exists={})",
                    e, binary, bin_exists, dir_info, dir_exists
                )
            })?;

        claude_register(&process_id, child.id());

        // Feed the prompt on a separate thread: the child can block writing
        // stdout while we are still writing stdin, and doing both on this thread
        // would deadlock. Dropping the handle closes stdin so claude knows the
        // prompt is complete.
        if prompt_via_stdin {
            if let Some(mut stdin) = child.stdin.take() {
                std::thread::spawn(move || {
                    use std::io::Write;
                    let _ = stdin.write_all(message.as_bytes());
                    let _ = stdin.flush();
                });
            }
        }

        // Stderr en thread separado
        let stderr_handle = child.stderr.take();
        let stderr_thread = std::thread::spawn(move || {
            let mut err_output = String::new();
            if let Some(mut stderr) = stderr_handle {
                let _ = stderr.read_to_string(&mut err_output);
            }
            err_output
        });

        let mut full_response = String::new();
        let mut claude_session_id: Option<String> = None;
        let mut usage_info: Option<UsageInfo> = None;
        let mut killed_for_interaction = false;

        // Tool use tracking
        let mut active_tool_name: Option<String> = None;
        let mut active_tool_id: Option<String> = None;
        let mut active_tool_index: Option<u64> = None;
        let mut tool_input_buf = String::new();
        let mut tool_id_to_name: HashMap<String, String> = HashMap::new();

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                if line.trim().is_empty() {
                    continue;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                    let line_type = json.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    // Capturar session_id
                    if claude_session_id.is_none() {
                        if let Some(sid) = json.get("session_id").and_then(|s| s.as_str()) {
                            claude_session_id = Some(sid.to_string());
                            let _ = on_event.send(StreamChunk {
                                content: String::new(),
                                done: false,
                                session_id: Some(sid.to_string()),
                                usage: None,
                                tool: None,
                            });
                        }
                    }

                    if line_type == "stream_event" {
                        let event = json.get("event");
                        let event_type = event
                            .and_then(|e| e.get("type"))
                            .and_then(|t| t.as_str())
                            .unwrap_or("");

                        match event_type {
                            "content_block_delta" => {
                                if let Some(delta) = event.and_then(|e| e.get("delta")) {
                                    let delta_type =
                                        delta.get("type").and_then(|t| t.as_str()).unwrap_or("");

                                    if delta_type == "text_delta" {
                                        if let Some(text) =
                                            delta.get("text").and_then(|t| t.as_str())
                                        {
                                            full_response.push_str(text);
                                            let _ = on_event.send(StreamChunk {
                                                content: text.to_string(),
                                                done: false,
                                                session_id: None,
                                                usage: None,
                                                tool: None,
                                            });
                                        }
                                    } else if delta_type == "input_json_delta" {
                                        if let Some(partial) =
                                            delta.get("partial_json").and_then(|t| t.as_str())
                                        {
                                            tool_input_buf.push_str(partial);
                                        }
                                    }
                                }
                            }

                            "content_block_start" => {
                                if let Some(block) = event.and_then(|e| e.get("content_block")) {
                                    if block.get("type").and_then(|t| t.as_str())
                                        == Some("tool_use")
                                    {
                                        let name = block
                                            .get("name")
                                            .and_then(|n| n.as_str())
                                            .unwrap_or("unknown")
                                            .to_string();
                                        let id = block
                                            .get("id")
                                            .and_then(|i| i.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        let index = event
                                            .and_then(|e| e.get("index"))
                                            .and_then(|i| i.as_u64());

                                        active_tool_name = Some(name.clone());
                                        active_tool_id = Some(id.clone());
                                        active_tool_index = index;
                                        tool_input_buf.clear();
                                        tool_id_to_name.insert(id, name);
                                    }
                                }
                            }

                            "content_block_stop" => {
                                let stop_index = event
                                    .and_then(|e| e.get("index"))
                                    .and_then(|i| i.as_u64());
                                if stop_index == active_tool_index && active_tool_name.is_some() {
                                    let input_json =
                                        serde_json::from_str::<serde_json::Value>(&tool_input_buf)
                                            .unwrap_or(serde_json::Value::Null);

                                    let tool_name_str =
                                        active_tool_name.clone().unwrap_or_default();
                                    let tool_id_str = active_tool_id.clone().unwrap_or_default();

                                    let is_ask_user = tool_name_str == "AskUserQuestion";
                                    let needs_approval = if !is_ask_user {
                                        if let Some(ref approved) = allowed_tools {
                                            !approved.iter().any(|t| t == &tool_name_str)
                                        } else {
                                            false
                                        }
                                    } else {
                                        false
                                    };

                                    if is_ask_user || needs_approval {
                                        let phase = if is_ask_user {
                                            "ask".to_string()
                                        } else {
                                            "approval".to_string()
                                        };

                                        let _ = on_event.send(StreamChunk {
                                            content: String::new(),
                                            done: false,
                                            session_id: None,
                                            usage: None,
                                            tool: Some(ToolActivity {
                                                tool_name: tool_name_str,
                                                tool_id: tool_id_str,
                                                phase,
                                                input: Some(input_json),
                                                result: None,
                                                is_error: None,
                                            }),
                                        });

                                        let _ = claude_stop(&process_id);
                                        killed_for_interaction = true;
                                        break;
                                    }

                                    // Auto-approved tool
                                    let _ = on_event.send(StreamChunk {
                                        content: String::new(),
                                        done: false,
                                        session_id: None,
                                        usage: None,
                                        tool: Some(ToolActivity {
                                            tool_name: tool_name_str,
                                            tool_id: tool_id_str,
                                            phase: "start".to_string(),
                                            input: Some(input_json),
                                            result: None,
                                            is_error: None,
                                        }),
                                    });

                                    active_tool_name = None;
                                    active_tool_id = None;
                                    active_tool_index = None;
                                    tool_input_buf.clear();
                                }
                            }

                            _ => {}
                        }
                    }

                    // Tool result
                    if line_type == "user" {
                        if let Some(content) = json
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_array())
                        {
                            for item in content {
                                if item.get("type").and_then(|t| t.as_str())
                                    == Some("tool_result")
                                {
                                    let tool_id = item
                                        .get("tool_use_id")
                                        .and_then(|t| t.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let result_content = item
                                        .get("content")
                                        .and_then(|c| c.as_str())
                                        .unwrap_or("")
                                        .to_string();
                                    let is_error = item
                                        .get("is_error")
                                        .and_then(|e| e.as_bool())
                                        .unwrap_or(false);

                                    let tool_name = tool_id_to_name
                                        .get(&tool_id)
                                        .cloned()
                                        .unwrap_or_else(|| {
                                            json.get("tool_use_result")
                                                .and_then(|r| r.get("tool_name"))
                                                .and_then(|n| n.as_str())
                                                .unwrap_or("Tool")
                                                .to_string()
                                        });

                                    let _ = on_event.send(StreamChunk {
                                        content: String::new(),
                                        done: false,
                                        session_id: None,
                                        usage: None,
                                        tool: Some(ToolActivity {
                                            tool_name,
                                            tool_id,
                                            phase: "result".to_string(),
                                            input: None,
                                            result: Some(result_content),
                                            is_error: Some(is_error),
                                        }),
                                    });
                                }
                            }
                        }
                    }

                    // Usage info
                    if line_type == "result" {
                        if let Some(usage) = json.get("usage") {
                            let input = usage
                                .get("input_tokens")
                                .and_then(|t| t.as_u64())
                                .unwrap_or(0);
                            let cache_create = usage
                                .get("cache_creation_input_tokens")
                                .and_then(|t| t.as_u64())
                                .unwrap_or(0);
                            let cache_read = usage
                                .get("cache_read_input_tokens")
                                .and_then(|t| t.as_u64())
                                .unwrap_or(0);
                            let output = usage
                                .get("output_tokens")
                                .and_then(|t| t.as_u64())
                                .unwrap_or(0);

                            usage_info = Some(UsageInfo {
                                input_tokens: input + cache_create + cache_read,
                                output_tokens: output,
                            });
                        }
                    }
                }
            }
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        let stderr_output = stderr_thread.join().unwrap_or_default();

        // Limpiar archivo temporal MCP
        drop(_mcp_temp_file);

        claude_unregister(&process_id);

        let _ = on_event.send(StreamChunk {
            content: String::new(),
            done: true,
            session_id: None,
            usage: usage_info,
            tool: None,
        });

        if killed_for_interaction {
            return Ok(full_response.trim().to_string());
        }

        if status.success() || !full_response.trim().is_empty() {
            Ok(full_response.trim().to_string())
        } else {
            let err_msg = if stderr_output.trim().is_empty() {
                format!("Claude salio con codigo: {}", status.code().unwrap_or(-1))
            } else {
                stderr_output.trim().to_string()
            };
            Err(err_msg)
        }
    })
    .await
}

#[tauri::command]
fn stop_claude(process_id: String) -> Result<(), String> {
    claude_stop(&process_id)
}

// -- Update: Auto-update commands --------------------------------------------

/// Ruta fija del paquete descargado, dentro del cache del usuario (0700).
/// Antes era /tmp/potato-update.deb: compartido entre usuarios, cualquiera
/// podia reemplazarlo entre la descarga y el `pkexec dpkg -i`.
fn update_package_path() -> Result<PathBuf, String> {
    let dir = dirs::cache_dir()
        .ok_or("No se encontro el directorio de cache")?
        .join("potato");
    fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir.join("potato-update.deb"))
}

#[tauri::command]
async fn download_update(app: tauri::AppHandle, url: String) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("URL de actualizacion invalida.".to_string());
    }
    run_blocking(move || {
        let dest = update_package_path()?;
        let _ = fs::remove_file(&dest);

        let mut child = std::process::Command::new("curl")
            .args(["-L", "-f", "--progress-bar", "-o"])
            .arg(&dest)
            .args(["--", &url])
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar curl: {e}"))?;

        // curl usa \r para su barra de progreso
        if let Some(stderr) = child.stderr.take() {
            let mut last_emitted: u32 = 0;
            for_each_progress_line(stderr, |line| {
                if let Some(pct) = parse_percent(line).map(|p| p.min(100)) {
                    if pct >= last_emitted + 2 || pct == 100 {
                        last_emitted = pct;
                        let _ = app.emit("update-progress", Progress {
                            phase: "Descargando".to_string(),
                            percent: pct,
                        });
                    }
                }
            });
        }

        let status = child.wait().map_err(|e| format!("Error esperando curl: {e}"))?;

        if status.success() && dest.exists() {
            Ok(dest.to_string_lossy().into_owned())
        } else {
            let _ = fs::remove_file(&dest);
            Err("Error al descargar la actualizacion. Verifica tu conexion a internet.".to_string())
        }
    })
    .await
}

/// Instala el paquete descargado por `download_update`. El parametro `path` se
/// conserva por compatibilidad con el frontend, pero solo se acepta la ruta
/// fija del cache: no se instala como root un archivo arbitrario.
#[tauri::command]
async fn install_update(path: String) -> Result<(), String> {
    run_blocking(move || {
        let expected = update_package_path()?;
        if std::path::Path::new(&path) != expected {
            return Err("Ruta de actualizacion no permitida.".to_string());
        }
        if !expected.exists() {
            return Err("Archivo de actualizacion no encontrado.".to_string());
        }

        let output = std::process::Command::new("pkexec")
            .args(["dpkg", "-i"])
            .arg(&expected)
            .output()
            .map_err(|e| format!("No se pudo ejecutar pkexec: {e}"))?;

        // Limpiar el paquete sin importar el resultado
        let _ = fs::remove_file(&expected);

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("dismissed") || stderr.contains("Not authorized") || output.status.code() == Some(126) {
                Err("Instalacion cancelada por el usuario.".to_string())
            } else {
                Err(format!("Error al instalar: {stderr}"))
            }
        }
    })
    .await
}

#[tauri::command]
async fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("No se pudo obtener la ruta del ejecutable: {}", e))?;

    // After dpkg -i replaces the binary, /proc/self/exe points to "path (deleted)"
    let exe_str = exe.to_string_lossy().to_string();
    let exe_path = if exe_str.ends_with(" (deleted)") {
        PathBuf::from(exe_str.trim_end_matches(" (deleted)"))
    } else {
        exe
    };

    std::process::Command::new(&exe_path)
        .spawn()
        .map_err(|e| format!("No se pudo reiniciar la app: {}", e))?;

    app.exit(0);

    Ok(())
}

// -- Comandos: Recent Files --------------------------------------------------

#[derive(Serialize, Clone)]
pub struct RecentFile {
    path: String,
    name: String,
    author: String,
    date: String,
}

#[tauri::command]
async fn git_recent_files(path: String, limit: Option<usize>) -> Result<Vec<RecentFile>, String> {
    run_blocking(move || {
        let max = limit.unwrap_or(20);

        let output = git_cmd(&path)
            .args([
                "log", "--all", "--diff-filter=A", "--name-only",
                "--pretty=format:COMMIT_SEP|%an|%as",
                "--", "*.md",
            ])
            .output()
            .map_err(|e| format!("Error git log: {}", e))?;

        if !output.status.success() {
            return Ok(Vec::new());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut results: Vec<RecentFile> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut current_author = String::new();
        let mut current_date = String::new();

        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("COMMIT_SEP|") {
                let parts: Vec<&str> = trimmed.splitn(3, '|').collect();
                if parts.len() >= 3 {
                    current_author = parts[1].to_string();
                    current_date = parts[2].to_string();
                }
            } else if trimmed.ends_with(".md") {
                if seen.contains(trimmed) {
                    continue;
                }
                seen.insert(trimmed.to_string());

                let full_path = format!("{}/{}", path, trimmed);
                // Only include files that still exist
                if !std::path::Path::new(&full_path).exists() {
                    continue;
                }

                let name = trimmed.rsplit('/').next().unwrap_or(trimmed)
                    .trim_end_matches(".md").to_string();

                results.push(RecentFile {
                    path: full_path,
                    name,
                    author: current_author.clone(),
                    date: current_date.clone(),
                });

                if results.len() >= max {
                    break;
                }
            }
        }

        Ok(results)
    })
    .await
}

// -- App ---------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_vault,
            list_vault,
            read_note,
            save_note,
            note_stat,
            log_frontend,
            diag_note_path,
            create_note,
            git_clone,
            git_status,
            git_pull,
            git_changed_files,
            git_share_link,
            git_stage_files,
            git_commit,
            git_push,
            git_recent_files,
            pick_folder,
            pick_pdf_path,
            export_pdf,
            move_file,
            open_in_explorer,
            search_vault,
            save_session,
            load_session,
            check_claude,
            send_claude_message,
            stop_claude,
            list_claude_agents,
            list_claude_commands,
            read_claude_command,
            scan_mcp_servers,
            download_update,
            install_update,
            restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn md_description_prefers_frontmatter_field() {
        let md = "---\nname: x\ndescription: \"Revisa PRs\"\n---\n# Titulo\nCuerpo";
        assert_eq!(md_description(md), "Revisa PRs");
    }

    #[test]
    fn md_description_falls_back_to_first_text_line() {
        assert_eq!(md_description("---\nname: x\n---\n# T\n\nHola"), "Hola");
        assert_eq!(md_description("# T\n\nPrimera linea"), "Primera linea");
        assert_eq!(md_description(""), "");
    }

    #[test]
    fn progress_lines_split_on_cr_and_lf_and_keep_utf8() {
        let input = "Recibiendo 10%\rRecibiendo 20%\nAño 30%\r\n".as_bytes();
        let mut lines = Vec::new();
        for_each_progress_line(input, |l| lines.push(l.to_string()));
        assert_eq!(lines, ["Recibiendo 10%", "Recibiendo 20%", "Año 30%"]);
    }

    #[test]
    fn parse_percent_handles_decimals() {
        assert_eq!(parse_percent("###### 42.5%"), Some(42));
        assert_eq!(parse_percent("Receiving objects: 100% (5/5)"), Some(100));
        assert_eq!(parse_percent("sin progreso"), None);
    }

    #[test]
    fn validate_plain_name_rejects_traversal() {
        assert!(validate_plain_name("nota").is_ok());
        assert!(validate_plain_name("../etc/passwd").is_err());
        assert!(validate_plain_name("a/b").is_err());
        assert!(validate_plain_name(".oculto").is_err());
        assert!(validate_plain_name("").is_err());
    }
}
