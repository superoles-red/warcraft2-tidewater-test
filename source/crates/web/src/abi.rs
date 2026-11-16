//! Glue between the browser's byte arrays and the engine. JavaScript can write only the input
//! buffer provided by this interface. Rust never creates a slice from a caller-supplied pointer.
#![allow(unsafe_code)] // Only the named WebAssembly export attributes require unsafe.

use std::cell::RefCell;

use crate::Engine;

#[derive(Default)]
struct Exchange {
    engine: Option<Engine>,
    input: Vec<u8>,
    output: Vec<u8>,
}

thread_local! {
    static EXCHANGE: RefCell<Exchange> = RefCell::default();
}

const MAX_INPUT: usize = 128 * 1024 * 1024;

#[unsafe(no_mangle)]
pub extern "C" fn wc2_input(len: usize) -> *mut u8 {
    if len == 0 || len > MAX_INPUT {
        return std::ptr::null_mut();
    }
    EXCHANGE.with_borrow_mut(|exchange| {
        exchange.input.resize(len, 0);
        exchange.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_output() -> *const u8 {
    EXCHANGE.with_borrow(|exchange| exchange.output.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_output_len() -> usize {
    EXCHANGE.with_borrow(|exchange| exchange.output.len())
}

fn respond(exchange: &mut Exchange, result: anyhow::Result<Vec<u8>>) -> u32 {
    match result {
        Ok(output) => {
            exchange.output = output;
            0
        }
        Err(error) => {
            exchange.output = format!("{error:#}").into_bytes();
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_init(data_len: usize) -> u32 {
    EXCHANGE.with_borrow_mut(|exchange| {
        let mut data = std::mem::take(&mut exchange.input);
        let result = if data_len > 0 && data_len <= data.len() {
            let patch = data.split_off(data_len);
            Engine::open(data, patch).map(|engine| {
                exchange.engine = Some(engine);
                Vec::new()
            })
        } else {
            Err(anyhow::anyhow!("The Warcraft II archives are missing"))
        };
        respond(exchange, result)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_request() -> u32 {
    EXCHANGE.with_borrow_mut(|exchange| {
        let result = exchange
            .engine
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("The mission is not running"))
            .and_then(|engine| engine.request(&exchange.input));
        respond(exchange, result)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_scenario(metadata_len: usize) -> u32 {
    EXCHANGE.with_borrow_mut(|exchange| {
        let result = exchange
            .engine
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("The mission is not running"))
            .and_then(|engine| {
                let (metadata, data) = exchange
                    .input
                    .split_at_checked(metadata_len)
                    .ok_or_else(|| anyhow::anyhow!("The scenario data is missing"))?;
                engine.load_scenario(metadata, data)
            });
        respond(exchange, result)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_save_checkpoint() -> u32 {
    EXCHANGE.with_borrow_mut(|exchange| {
        let result = exchange
            .engine
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The mission is not running"))
            .and_then(Engine::save_checkpoint);
        respond(exchange, result)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn wc2_restore_checkpoint() -> u32 {
    EXCHANGE.with_borrow_mut(|exchange| {
        let result = exchange
            .engine
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("The mission is not running"))
            .and_then(|engine| engine.restore_checkpoint(&exchange.input));
        respond(exchange, result)
    })
}
