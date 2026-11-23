// Windows'ta konsol penceresi açılmasın
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kesit_lib::run()
}
