//! Bucketed top-K reservoir: keep only the best few boards per (size × mechanic-mix × band) bucket
//! so a campaign that screens millions holds at most a few thousand in memory and on disk. This is
//! what replaces the unscalable "one `gen-*.json` file per board" scheme for high-volume runs.

use crate::curate::{mechanics_of, Mechanic};
use crate::io::LevelRecord;
use std::collections::HashMap;

/// Coarse size class from a layout's cell count.
fn size_class(layout: &[String]) -> &'static str {
    let rows = layout.len();
    let cols = layout.first().map(|r| r.chars().count()).unwrap_or(0);
    match rows * cols {
        0..=16 => "small",
        17..=30 => "mid",
        31..=48 => "large",
        _ => "huge",
    }
}

/// A stable tag for the mechanic mix (so single-mechanic and combined boards bucket separately).
fn mech_tag(layout: &[String]) -> String {
    let m = mechanics_of(layout);
    if m.is_empty() {
        return "none".to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    if m.contains(&Mechanic::Line) {
        parts.push("line");
    }
    if m.contains(&Mechanic::Explosive) {
        parts.push("explosive");
    }
    if m.contains(&Mechanic::Shift) {
        parts.push("shift");
    }
    if m.contains(&Mechanic::Arrow) {
        parts.push("arrow");
    }
    // A single mechanic keeps its own bucket; any combination collapses to "combined".
    if parts.len() == 1 {
        parts[0].to_string()
    } else {
        "combined".to_string()
    }
}

/// Bucket key: `size|mechanic|band`, e.g. `large|combined|expert`.
pub fn bucket_key(rec: &LevelRecord) -> String {
    format!(
        "{}|{}|{}",
        size_class(&rec.layout),
        mech_tag(&rec.layout),
        rec.band
    )
}

fn quality_of(rec: &LevelRecord) -> f64 {
    rec.difficulty.unwrap_or(f64::NEG_INFINITY)
}

/// A bounded best-of-K reservoir, partitioned into buckets.
pub struct TopK {
    cap: usize,
    buckets: HashMap<String, Vec<LevelRecord>>,
}

impl TopK {
    pub fn new(cap: usize) -> Self {
        TopK {
            cap: cap.max(1),
            buckets: HashMap::new(),
        }
    }

    /// Rebuild from a previously-flushed pool (for `--resume`).
    pub fn from_records(records: Vec<LevelRecord>, cap: usize) -> Self {
        let mut t = TopK::new(cap);
        for r in records {
            t.offer(r);
        }
        t
    }

    /// Offer a scored board; it's kept only if it's among the best `cap` in its bucket.
    pub fn offer(&mut self, rec: LevelRecord) {
        let key = bucket_key(&rec);
        let bucket = self.buckets.entry(key).or_default();
        bucket.push(rec);
        if bucket.len() > self.cap * 2 {
            prune(bucket, self.cap);
        }
    }

    /// Total boards currently held (after an implicit prune).
    pub fn len(&self) -> usize {
        self.buckets.values().map(|b| b.len().min(self.cap)).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// All kept boards, each bucket trimmed to `cap`, sorted by descending quality.
    pub fn all(&self) -> Vec<LevelRecord> {
        let mut out: Vec<LevelRecord> = Vec::new();
        let mut keys: Vec<&String> = self.buckets.keys().collect();
        keys.sort();
        for k in keys {
            let mut b = self.buckets[k].clone();
            prune(&mut b, self.cap);
            out.extend(b);
        }
        out
    }

    /// Per-bucket (key, count, best-quality) summary, sorted by best quality descending.
    pub fn summary(&self) -> Vec<(String, usize, f64)> {
        let mut rows: Vec<(String, usize, f64)> = self
            .buckets
            .iter()
            .map(|(k, b)| {
                let best = b.iter().map(quality_of).fold(f64::NEG_INFINITY, f64::max);
                (k.clone(), b.len().min(self.cap), best)
            })
            .collect();
        rows.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        rows
    }
}

/// Sort a bucket by descending quality (ties broken by layout for determinism) and trim to `cap`.
fn prune(bucket: &mut Vec<LevelRecord>, cap: usize) {
    bucket.sort_by(|a, b| {
        quality_of(b)
            .partial_cmp(&quality_of(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.layout.cmp(&b.layout))
    });
    bucket.truncate(cap);
}
