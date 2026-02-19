#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        match args[1].as_str() {
            "--version" | "-v" | "-V" => {
                println!("Hola José, aquí está la versión");
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
