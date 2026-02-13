use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read as IoRead;
use std::path::PathBuf;
use std::process::Stdio;
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
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
