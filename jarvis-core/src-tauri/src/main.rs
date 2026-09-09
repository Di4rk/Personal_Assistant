// Ẩn console window trên Windows release build (không ảnh hưởng debug build)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jarvis_core_lib::run();
}
