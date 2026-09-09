//! Authored property surfaces, separate from the derived metadata cache.
//! Callers supply a table to parsing; configuration can replace this default later.

use crate::hooks::parsing::{PropSpec, PropSurface};

pub fn default_prop_table() -> Vec<PropSpec> {
    vec![PropSpec {
        key: "status".into(),
        surface: PropSurface::Glyph,
        glyphs: [
            ("todo", "⬜"),
            ("doing", "🟨"),
            ("done", "✅"),
            ("waiting", "👀"),
        ]
        .into_iter()
        .map(|(value, glyph)| (value.into(), glyph.into()))
        .collect(),
    }]
}
