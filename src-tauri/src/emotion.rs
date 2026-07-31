//! R29 (2026-07-31) — Emotion detection module.
//!
//! Migrated from upstream `backend/emotion.js` (85 LOC). Lightweight
//! keyword-based emotion sniffer — turns the last user prompt or Claude
//! reply into a short-lived "vibe" tag the octopus can react to with a
//! matching expression.
//!
//! Conservative: false-negative > false-positive — one wrong face is more
//! annoying than a missed one. Never blocks anything: returns None when in
//! doubt. Role-gated so loved/sad only fire from the user, sorry/puzzled
//! only fire from the assistant, and excited can come from either side.

/// Negation lookback — if the chars BEFORE a keyword contain a negation
/// particle, treat the match as flipped (e.g. "不太好" ≠ loved).
const NEGATION_RE_CN: &[char] = &['不', '没', '别', '勿', '无'];

/// English negation words (case-insensitive).
const NEGATION_WORDS_EN: &[&str] = &[
    "not ", "no ", "don't ", "doesn't ", "isn't ", "wasn't ", "never ", "hardly ", "barely ",
];

/// Emotion type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Emotion {
    Loved,
    Sad,
    Sorry,
    Excited,
    Puzzled,
}

impl Emotion {
    pub fn as_str(&self) -> &'static str {
        match self {
            Emotion::Loved => "loved",
            Emotion::Sad => "sad",
            Emotion::Sorry => "sorry",
            Emotion::Excited => "excited",
            Emotion::Puzzled => "puzzled",
        }
    }
}

/// Each emotion has CN and EN keyword lists. First match wins (priority order).
struct EmotionDef {
    emotion: Emotion,
    cn: &'static [&'static str],
    en: &'static [&'static str],
}

#[rustfmt::skip]
const EMOTIONS: &[EmotionDef] = &[
    EmotionDef {
        emotion: Emotion::Loved,
        cn: &["你最棒", "太牛了", "太牛", "真牛", "真棒", "绝了", "yyds", "666", "多谢", "谢谢", "感谢", "辛苦了", "真厉害", "给力", "点赞", "棒极了", "非常好", "干得漂亮", "干得好", "做得好", "太好了", "太赞了", "满意"],
        en: &["awesome", "amazing", "perfect", "wonderful", "great work", "great job", "well done", "nice job", "nice work", "love it", "beautiful", "thank you", "thanks", "appreciate it"],
    },
    EmotionDef {
        emotion: Emotion::Sad,
        cn: &["又错了", "错了", "搞砸", "失望", "烦死", "烦人", "真讨厌", "讨厌", "气死", "怎么搞的", "不像话", "算了吧", "真无语", "无语", "糟糕", "糟透了", "一团糟", "又坏了", "你怎么回事", "别再错"],
        en: &["disappointing", "frustrating", "terrible", "awful", "garbage", "useless", "what the hell", "damn it", "seriously?"],
    },
    EmotionDef {
        emotion: Emotion::Sorry,
        cn: &["抱歉", "对不起", "不好意思", "我错了", "是我错了", "是我的疏忽", "我的失误", "失误了", "道歉", "没注意到", "没考虑到", "疏忽了", "请见谅"],
        en: &["sorry", "apologize", "my mistake", "my bad", "my apologies", "i was wrong"],
    },
    EmotionDef {
        emotion: Emotion::Excited,
        cn: &["搞定了", "大功告成", "完美收工", "一气呵成", "终于", "搞定！", "完工"],
        en: &["nailed it", "finally", "yay", "woohoo", "shipped it", "let's go", "lets go"],
    },
    EmotionDef {
        emotion: Emotion::Puzzled,
        cn: &["不太确定", "我不确定", "也许", "可能是", "不清楚", "似乎", "看起来像", "大概", "或许", "不一定"],
        en: &["not sure", "not entirely sure", "maybe", "perhaps", "seems like", "it looks like"],
    },
];

/// Check if the 8 chars before `idx` in `text` contain a negation particle.
fn neighbor_negation(text: &str, idx: usize) -> bool {
    // Take the last 8 chars before idx (char-level, not byte-level).
    let before: Vec<char> = text.chars().take(idx).collect();
    let window: String = before
        .iter()
        .rev()
        .take(8)
        .copied()
        .collect::<Vec<_>>()
        .iter()
        .rev()
        .collect();
    // Check CN negation chars
    for ch in window.chars() {
        if NEGATION_RE_CN.contains(&ch) {
            return true;
        }
    }
    // Check EN negation words (case-insensitive)
    let lower = window.to_lowercase();
    for word in NEGATION_WORDS_EN {
        if lower.contains(word) {
            return true;
        }
    }
    false
}

/// Find a keyword match in text, checking for negation.
/// `is_cn` determines whether to use substring match (CN) or word-boundary match (EN).
fn find_one(text: &str, words: &[&str], is_cn: bool) -> bool {
    for w in words {
        if is_cn {
            if let Some(idx) = text.find(w) {
                // Convert byte index to char index for negation check
                let char_idx = text[..idx].chars().count();
                if !neighbor_negation(text, char_idx) {
                    return true;
                }
            }
        } else {
            // Case-insensitive word-boundary match
            let lower = text.to_lowercase();
            if let Some(idx) = lower.find(&w.to_lowercase()) {
                let char_idx = text[..idx].chars().count();
                if !neighbor_negation(text, char_idx) {
                    return true;
                }
            }
        }
    }
    false
}

/// Role determines which emotions are allowed.
fn role_allows(role: &str, emotion: Emotion) -> bool {
    match role {
        "user" => matches!(emotion, Emotion::Loved | Emotion::Sad | Emotion::Excited),
        "assistant" => matches!(
            emotion,
            Emotion::Sorry | Emotion::Puzzled | Emotion::Excited
        ),
        _ => true, // Unknown role: allow all
    }
}

/// Detect emotion from text. Returns None when no emotion is detected
/// or when the text is too long/empty.
///
/// - `text`: the message text to analyze
/// - `role`: "user" or "assistant"
pub fn detect_emotion(text: &str, role: &str) -> Option<Emotion> {
    let t = text.trim();
    if t.is_empty() || t.len() > 6000 {
        return None;
    }
    // Emotion lives in the recent sentiment, not the whole essay.
    let tail = if t.len() > 1500 {
        &t[t.len() - 1500..]
    } else {
        t
    };
    for def in EMOTIONS {
        if !role_allows(role, def.emotion) {
            continue;
        }
        if find_one(tail, def.cn, true) {
            return Some(def.emotion);
        }
        if find_one(tail, def.en, false) {
            return Some(def.emotion);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_loved_user() {
        assert_eq!(detect_emotion("太牛了", "user"), Some(Emotion::Loved));
        assert_eq!(detect_emotion("awesome work", "user"), Some(Emotion::Loved));
    }

    #[test]
    fn test_negation() {
        assert_eq!(detect_emotion("不太好", "user"), None);
        assert_eq!(detect_emotion("not great", "user"), None);
    }

    #[test]
    fn test_role_gating() {
        // sorry only from assistant
        assert_eq!(detect_emotion("抱歉", "user"), None);
        assert_eq!(detect_emotion("抱歉", "assistant"), Some(Emotion::Sorry));
    }

    #[test]
    fn test_empty_and_long() {
        assert_eq!(detect_emotion("", "user"), None);
        assert_eq!(detect_emotion(&"a".repeat(6001), "user"), None);
    }
}
