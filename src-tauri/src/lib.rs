use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read as IoRead};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Emitter;

#[derive(Serialize, Clone)]
pub struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileEntry>,
}

#[derive(Serialize, Clone)]
pub struct WikiLink {
    target: String,
    display: String,
}

// -- Comandos: Vault ---------------------------------------------------------

#[tauri::command]
fn open_vault() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Seleccionar Vault")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
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
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Ignorar archivos/dirs ocultos
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            dirs.push(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                children: build_tree(&path),
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
                children: vec![],
            });
        }
    }

    dirs.sort_by(|a, b| a.name.cmp(&b.name));
    files.sort_by(|a, b| a.name.cmp(&b.name));
    dirs.extend(files);
    dirs
}

// -- Comandos: Notas ---------------------------------------------------------

#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_note(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_note(vault_path: String, name: String) -> Result<String, String> {
    let file_path = PathBuf::from(&vault_path).join(format!("{}.md", name));
    let content = format!("# {}\n\n", name);
    fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

// -- Comandos: Wikilinks -----------------------------------------------------

#[tauri::command]
fn parse_wikilinks(content: String) -> Vec<WikiLink> {
    let re = Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap();
    re.captures_iter(&content)
        .map(|cap| WikiLink {
            target: cap[1].to_string(),
            display: cap
                .get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_else(|| cap[1].to_string()),
        })
        .collect()
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
fn git_cmd(repo_path: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.args(["-C", repo_path]);
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
    cmd
}

/// Helper: git command sin -C (para clone)
fn git_cmd_bare() -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
    cmd
}

#[derive(Serialize, Clone)]
struct GitProgress {
    phase: String,
    percent: u32,
}

#[tauri::command]
async fn git_clone(app: tauri::AppHandle, url: String, path: String) -> Result<String, String> {
    let app_handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let mut child = git_cmd_bare()
            .args(["clone", "--progress", &url, &path])
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar git: {}", e))?;

        // Read stderr byte by byte (git uses \r for progress)
        if let Some(stderr) = child.stderr.take() {
            let re = Regex::new(r"(\d+)%").unwrap();
            let mut line_buf = String::new();

            for byte in stderr.bytes().flatten() {
                if byte == b'\r' || byte == b'\n' {
                    if !line_buf.is_empty() {
                        // Parse phase and percent
                        let phase = if line_buf.contains("Counting") {
                            "Contando objetos"
                        } else if line_buf.contains("Compressing") {
                            "Comprimiendo"
                        } else if line_buf.contains("Receiving") {
                            "Recibiendo objetos"
                        } else if line_buf.contains("Resolving") {
                            "Resolviendo deltas"
                        } else if line_buf.contains("Cloning") {
                            "Conectando"
                        } else {
                            ""
                        };

                        if !phase.is_empty() {
                            let percent = re.captures(&line_buf)
                                .and_then(|c| c[1].parse::<u32>().ok())
                                .unwrap_or(0);

                            // Map phases to overall progress
                            let overall = match phase {
                                "Conectando" => 2,
                                "Contando objetos" => 5 + percent / 10,
                                "Comprimiendo" => 15 + percent / 5,
                                "Recibiendo objetos" => 35 + (percent * 50 / 100),
                                "Resolviendo deltas" => 85 + (percent * 15 / 100),
                                _ => percent,
                            };

                            let _ = app_handle.emit("git-progress", GitProgress {
                                phase: phase.to_string(),
                                percent: overall.min(100),
                            });
                        }

                        line_buf.clear();
                    }
                } else {
                    line_buf.push(byte as char);
                }
            }
        }

        let status = child.wait().map_err(|e| format!("Error esperando git: {}", e))?;

        // Emit 100% done
        let _ = app_handle.emit("git-progress", GitProgress {
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
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn git_status(path: String) -> Result<GitStatus, String> {
    tokio::task::spawn_blocking(move || {
        // Check if it's a git repo
        let is_repo = std::process::Command::new("git")
            .args(["-C", &path, "rev-parse", "--is-inside-work-tree"])
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

        let branch = std::process::Command::new("git")
            .args(["-C", &path, "branch", "--show-current"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let remote = std::process::Command::new("git")
            .args(["-C", &path, "remote", "get-url", "origin"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();

        let has_changes = std::process::Command::new("git")
            .args(["-C", &path, "status", "--porcelain"])
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
    .map_err(|e| format!("Task error: {}", e))?
}

#[derive(Serialize, Clone)]
pub struct GitFileChange {
    path: String,
    status: String,       // "modified", "new", "deleted", "renamed"
    status_code: String,  // "M", "?", "D", "R", "A"
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
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
            } else if stderr.contains("Authentication failed")
                || stderr.contains("Permission denied")
                || stderr.contains("terminal prompts disabled")
                || stderr.contains("could not read Username")
            {
                Err("auth_error".to_string())
            } else {
                Err(stderr)
            }
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn git_changed_files(path: String) -> Result<Vec<GitFileChange>, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_cmd(&path)
            .args(["status", "--porcelain"])
            .output()
            .map_err(|e| format!("Error en status: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut files = Vec::new();

        for line in stdout.lines() {
            if line.len() < 3 {
                continue;
            }
            let code = line[..2].trim().to_string();
            let file_path = line[3..].trim_start_matches("-> ").to_string();

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
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn git_stage_files(path: String, files: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
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
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
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
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let output = git_cmd(&path)
            .args(["push", "-u", "origin", "HEAD"])
            .output()
            .map_err(|e| format!("Error en push: {}", e))?;

        if output.status.success() {
            Ok("Push OK".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if stderr.contains("Authentication failed")
                || stderr.contains("Permission denied")
                || stderr.contains("terminal prompts disabled")
                || stderr.contains("could not read Username")
            {
                Err("auth_error".to_string())
            } else {
                Err(stderr)
            }
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
fn pick_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Elegir carpeta destino")
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
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
    tokio::task::spawn_blocking(move || {
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
    .map_err(|e| format!("Task error: {}", e))?
}

fn search_dir(dir: &PathBuf, query: &str, results: &mut Vec<SearchResult>) {
    let Ok(read_dir) = fs::read_dir(dir) else { return };

    for entry in read_dir.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            search_dir(&path, query, results);
        } else if path.extension().is_some_and(|e| e == "md") {
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();

            // Match file name
            if stem.to_lowercase().contains(query) {
                results.push(SearchResult {
                    path: path.to_string_lossy().to_string(),
                    name: stem.clone(),
                    match_type: "name".to_string(),
                    preview: String::new(),
                    line: 0,
                });
            }

            // Match content
            if let Ok(content) = fs::read_to_string(&path) {
                for (i, line_text) in content.lines().enumerate() {
                    if line_text.to_lowercase().contains(query) {
                        let preview = line_text.trim().chars().take(120).collect::<String>();
                        results.push(SearchResult {
                            path: path.to_string_lossy().to_string(),
                            name: stem.clone(),
                            match_type: "content".to_string(),
                            preview,
                            line: (i + 1) as u32,
                        });
                        // Max 3 content matches per file
                        if results.iter().filter(|r| r.path == path.to_string_lossy().to_string() && r.match_type == "content").count() >= 3 {
                            break;
                        }
                    }
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

#[tauri::command]
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

// -- Claude: Listar agentes --------------------------------------------------

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    name: String,
    description: String,
}

#[tauri::command]
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
                .ok()
                .and_then(|content| {
                    let lines: Vec<&str> = content.lines().collect();
                    // Si tiene frontmatter YAML (---), buscar campo description
                    if lines.first().map(|l| l.trim()) == Some("---") {
                        let end = lines.iter().skip(1).position(|l| l.trim() == "---");
                        if let Some(end_idx) = end {
                            // Buscar "description:" dentro del frontmatter
                            for line in &lines[1..=end_idx] {
                                if let Some(desc) = line.strip_prefix("description:") {
                                    let d = desc.trim().trim_matches('"').trim_matches('\'');
                                    if !d.is_empty() {
                                        return Some(d.chars().take(120).collect::<String>());
                                    }
                                }
                            }
                        }
                        // Frontmatter sin description: buscar primera linea despues
                        let skip = end.map(|i| i + 2).unwrap_or(1);
                        lines.iter().skip(skip).find(|l| {
                            let t = l.trim();
                            !t.is_empty() && !t.starts_with('#')
                        }).map(|l| l.trim().chars().take(120).collect::<String>())
                    } else {
                        // Sin frontmatter: primera linea no vacia ni titulo
                        lines.iter().find(|l| {
                            let t = l.trim();
                            !t.is_empty() && !t.starts_with('#')
                        }).map(|l| l.trim().chars().take(120).collect::<String>())
                    }
                })
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

struct ProcessEntry {
    pid: u32,
}

static CLAUDE_REGISTRY: Mutex<Option<HashMap<String, ProcessEntry>>> = Mutex::new(None);

fn claude_registry<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<String, ProcessEntry>) -> R,
{
    let mut guard = CLAUDE_REGISTRY.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    f(map)
}

fn claude_register(id: &str, pid: u32) {
    claude_registry(|map| {
        map.insert(id.to_string(), ProcessEntry { pid });
    });
}

fn claude_unregister(id: &str) {
    claude_registry(|map| {
        map.remove(id);
    });
}

fn claude_stop(id: &str) -> Result<(), String> {
    let pid = claude_registry(|map| map.remove(id).map(|e| e.pid));
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

#[tauri::command]
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
                .ok()
                .and_then(|content| {
                    let lines: Vec<&str> = content.lines().collect();
                    if lines.first().map(|l| l.trim()) == Some("---") {
                        let end = lines.iter().skip(1).position(|l| l.trim() == "---");
                        if let Some(end_idx) = end {
                            for line in &lines[1..=end_idx] {
                                if let Some(desc) = line.strip_prefix("description:") {
                                    let d = desc.trim().trim_matches('"').trim_matches('\'');
                                    if !d.is_empty() {
                                        return Some(d.chars().take(120).collect::<String>());
                                    }
                                }
                            }
                        }
                        let skip = end.map(|i| i + 2).unwrap_or(1);
                        lines.iter().skip(skip).find(|l| {
                            let t = l.trim();
                            !t.is_empty() && !t.starts_with('#')
                        }).map(|l| l.trim().chars().take(120).collect::<String>())
                    } else {
                        lines.iter().find(|l| {
                            let t = l.trim();
                            !t.is_empty() && !t.starts_with('#')
                        }).map(|l| l.trim().chars().take(120).collect::<String>())
                    }
                })
                .unwrap_or_default();

            commands.push(AgentInfo { name, description });
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands
}

#[tauri::command]
fn read_claude_command(path: String, command: String) -> Result<String, String> {
    let base = PathBuf::from(&path);
    let commands_dir = if base.ends_with(".claude/commands") || base.ends_with(".claude\\commands") {
        base
    } else if base.join("commands").is_dir() && base.ends_with(".claude") {
        base.join("commands")
    } else {
        base.join(".claude").join("commands")
    };
    let cmd_file = commands_dir.join(format!("{}.md", command));
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
                    if best.as_ref().map_or(true, |(b, _)| name > *b) {
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
    let mut guard = CLAUDE_BINARY.lock().unwrap();
    if let Some(ref path) = *guard {
        return Ok(path.clone());
    }

    // Intentar "claude" directo primero (por si está en el PATH del proceso)
    if let Ok(output) = std::process::Command::new("claude").arg("--version").output() {
        if output.status.success() {
            *guard = Some("claude".to_string());
            return Ok("claude".to_string());
        }
    }

    // Resolver ruta completa
    match resolve_claude_binary() {
        Some(path) => {
            *guard = Some(path.clone());
            Ok(path)
        }
        None => Err("Claude Code no esta instalado. Instala con: curl -fsSL https://claude.ai/install.sh | sh".to_string()),
    }
}

// -- Claude: Comandos --------------------------------------------------------

#[tauri::command]
fn check_claude() -> Result<String, String> {
    let binary = get_claude_binary()?;
    let output = std::process::Command::new(&binary)
        .arg("--version")
        .output()
        .map_err(|_| {
            "Claude Code no esta instalado. Instala con: curl -fsSL https://claude.ai/install.sh | sh"
                .to_string()
        })?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err("Claude Code no esta instalado. Instala con: curl -fsSL https://claude.ai/install.sh | sh".to_string())
    }
}

#[tauri::command]
async fn send_claude_message(
    message: String,
    process_id: String,
    session_id: Option<String>,
    model: Option<String>,
    working_dir: Option<String>,
    allowed_tools: Option<Vec<String>>,
    system_prompt: Option<String>,
    on_event: Channel<StreamChunk>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "--print".to_string(),
            "--verbose".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--include-partial-messages".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ];

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

        args.push(message);

        let binary = get_claude_binary()
            .map_err(|e| format!("No se encontro claude: {}", e))?;

        let mut cmd = std::process::Command::new(&binary);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(ref dir) = working_dir {
            cmd.current_dir(dir);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar claude: {}", e))?;

        claude_register(&process_id, child.id());

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

                                        active_tool_name = Some(name);
                                        active_tool_id = Some(id);
                                        active_tool_index = index;
                                        tool_input_buf.clear();
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

                                    let tool_name = json
                                        .get("tool_use_result")
                                        .and_then(|r| r.get("tool_name"))
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("Tool")
                                        .to_string();

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
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
fn stop_claude(process_id: String) -> Result<(), String> {
    claude_stop(&process_id)
}

// -- Update: Auto-update commands --------------------------------------------

#[derive(Serialize, Clone)]
struct UpdateProgress {
    phase: String,
    percent: u32,
}

#[tauri::command]
async fn download_update(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let app_handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let dest = "/tmp/potato-update.deb";

        // Remove previous download if exists
        let _ = fs::remove_file(dest);

        let mut child = std::process::Command::new("curl")
            .args(["-L", "-f", "-o", dest, "--progress-bar", &url])
            .stderr(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("No se pudo ejecutar curl: {}", e))?;

        // Parse stderr byte by byte for progress (curl uses \r for progress bar)
        if let Some(stderr) = child.stderr.take() {
            let re = Regex::new(r"(\d+)\.?\d*%").unwrap();
            let mut line_buf = String::new();
            let mut last_emitted: u32 = 0;

            for byte in stderr.bytes().flatten() {
                if byte == b'\r' || byte == b'\n' {
                    if !line_buf.is_empty() {
                        if let Some(caps) = re.captures(&line_buf) {
                            if let Ok(pct) = caps[1].parse::<u32>() {
                                let pct = pct.min(100);
                                if pct >= last_emitted + 2 || pct == 100 {
                                    last_emitted = pct;
                                    let _ = app_handle.emit("update-progress", UpdateProgress {
                                        phase: "Descargando".to_string(),
                                        percent: pct,
                                    });
                                }
                            }
                        }
                        line_buf.clear();
                    }
                } else {
                    line_buf.push(byte as char);
                }
            }
        }

        let status = child.wait().map_err(|e| format!("Error esperando curl: {}", e))?;

        if status.success() && PathBuf::from(dest).exists() {
            Ok(dest.to_string())
        } else {
            let _ = fs::remove_file(dest);
            Err("Error al descargar la actualizacion. Verifica tu conexion a internet.".to_string())
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

#[tauri::command]
async fn install_update(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if !PathBuf::from(&path).exists() {
            return Err("Archivo de actualizacion no encontrado.".to_string());
        }

        let output = std::process::Command::new("pkexec")
            .args(["dpkg", "-i", &path])
            .output()
            .map_err(|e| format!("No se pudo ejecutar pkexec: {}", e))?;

        // Clean up temp file regardless of result
        let _ = fs::remove_file(&path);

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if stderr.contains("dismissed") || stderr.contains("Not authorized") || output.status.code() == Some(126) {
                Err("Instalacion cancelada por el usuario.".to_string())
            } else {
                Err(format!("Error al instalar: {}", stderr))
            }
        }
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
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

// -- App ---------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_vault,
            list_vault,
            read_note,
            save_note,
            create_note,
            parse_wikilinks,
            git_clone,
            git_status,
            git_pull,
            git_changed_files,
            git_stage_files,
            git_commit,
            git_push,
            pick_folder,
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
            download_update,
            install_update,
            restart_app,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
