#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(arg) = std::env::args().nth(1) {
        match arg.as_str() {
            "--version" | "-v" | "-V" => {
                println!("POTATO {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--help" | "-h" => {
                println!("POTATO {} — Editor de notas markdown con IA integrada", env!("CARGO_PKG_VERSION"));
                println!();
                println!("USO:");
                println!("  potato [OPCIONES]");
                println!();
                println!("OPCIONES:");
                println!("  -v, --version    Muestra la versión");
                println!("  -h, --help       Muestra esta ayuda");
                return;
            }
            _ => {}
        }
    }
    potato_lib::run();
}
