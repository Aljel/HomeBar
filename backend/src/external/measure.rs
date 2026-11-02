//! Parser for free-form upstream measures ("1 1/2 oz", "2 cl", "3-4 dashes",
//! "Juice of 1", "175g", "top up", ...) into amount / normalised unit / note.

use crate::models::MAX_AMOUNT;

/// Result of parsing a measure string.
#[derive(Debug, Clone, PartialEq)]
pub struct Measure {
    pub amount: Option<f64>,
    pub unit: String,
    pub note: String,
}

impl Measure {
    fn unparsed(raw: &str) -> Self {
        Self {
            amount: None,
            unit: String::new(),
            note: raw.to_owned(),
        }
    }
}

/// Maps a (lower-case) unit word to its canonical form.
fn canonical_unit(word: &str) -> Option<&'static str> {
    let w = word.trim_end_matches('.');
    Some(match w {
        "ml" | "mls" | "milliliter" | "milliliters" | "millilitre" | "millilitres" => "ml",
        "cl" | "cls" | "centiliter" | "centiliters" | "centilitre" | "centilitres" => "cl",
        "dl" | "deciliter" | "decilitre" => "dl",
        "l" | "liter" | "liters" | "litre" | "litres" | "ltr" => "l",
        "oz" | "ozs" | "ounce" | "ounces" | "fl oz" | "fl. oz" | "fl.oz" => "oz",
        "tsp" | "tsps" | "tspn" | "teaspoon" | "teaspoons" | "t" => "tsp",
        "tbsp" | "tbsps" | "tblsp" | "tblsps" | "tbs" | "tbl" | "tbls" | "tablespoon"
        | "tablespoons" => "tbsp",
        "barspoon" | "barspoons" | "bar spoon" | "bar spoons" => "barspoon",
        "dash" | "dashes" => "dash",
        "drop" | "drops" => "drop",
        "splash" | "splashes" => "splash",
        "shot" | "shots" => "shot",
        "jigger" | "jiggers" => "jigger",
        "part" | "parts" => "part",
        "measure" | "measures" => "measure",
        "cup" | "cups" => "cup",
        "pint" | "pints" | "pt" => "pint",
        "quart" | "quarts" | "qt" => "quart",
        "gallon" | "gallons" | "gal" => "gallon",
        "g" | "gr" | "gram" | "grams" | "gramme" | "grammes" => "g",
        "kg" | "kgs" | "kilogram" | "kilograms" => "kg",
        "mg" => "mg",
        "lb" | "lbs" | "pound" | "pounds" => "lb",
        "pinch" | "pinches" => "pinch",
        "slice" | "slices" => "slice",
        "wedge" | "wedges" => "wedge",
        "twist" | "twists" => "twist",
        "sprig" | "sprigs" => "sprig",
        "leaf" | "leaves" => "leaf",
        "piece" | "pieces" | "pc" | "pcs" => "pcs",
        "cube" | "cubes" => "cube",
        "clove" | "cloves" => "clove",
        "can" | "cans" => "can",
        "bottle" | "bottles" => "bottle",
        "handful" | "handfuls" => "handful",
        "bunch" | "bunches" => "bunch",
        "scoop" | "scoops" => "scoop",
        "stalk" | "stalks" => "stalk",
        "stick" | "sticks" => "stick",
        "glass" | "glasses" => "glass",
        _ => return None,
    })
}

/// Vulgar fraction characters → ASCII equivalents (padded with spaces so that
/// "1½" becomes "1 1/2").
fn expand_unicode_fractions(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        let rep = match c {
            '½' => "1/2",
            '⅓' => "1/3",
            '⅔' => "2/3",
            '¼' => "1/4",
            '¾' => "3/4",
            '⅕' => "1/5",
            '⅛' => "1/8",
            '⅜' => "3/8",
            '⅝' => "5/8",
            '⅞' => "7/8",
            '⁄' => "/",
            _ => {
                out.push(c);
                continue;
            }
        };
        out.push(' ');
        out.push_str(rep);
        out.push(' ');
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Small cursor over the (ASCII-lowercased) measure.
struct Cursor<'a> {
    s: &'a str,
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.pos..]
    }

    fn skip_spaces(&mut self) {
        let trimmed = self.rest().trim_start();
        self.pos = self.s.len() - trimmed.len();
    }

    /// Parses an unsigned decimal ("2", "1.5", "0,75").
    fn decimal(&mut self) -> Option<f64> {
        let rest = self.rest();
        let bytes = rest.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == 0 {
            return None;
        }
        if end + 1 < bytes.len()
            && (bytes[end] == b'.' || bytes[end] == b',')
            && bytes[end + 1].is_ascii_digit()
        {
            end += 1;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
        }
        let value = rest[..end].replace(',', ".").parse().ok()?;
        self.pos += end;
        Some(value)
    }

    /// Parses "a/b" (if present) or a decimal.
    fn simple_number(&mut self) -> Option<f64> {
        let start = self.pos;
        let whole = self.decimal()?;
        let save = self.pos;
        let rest = self.rest();
        if let Some(after) = rest.strip_prefix('/') {
            self.pos += 1;
            if after.starts_with(|c: char| c.is_ascii_digit())
                && let Some(den) = self.decimal()
                && den != 0.0
            {
                return Some(whole / den);
            }
            self.pos = save;
        }
        if self.pos == start {
            return None;
        }
        Some(whole)
    }

    /// Parses a mixed number: "1 1/2", "1-1/2" or a simple number.
    fn number(&mut self) -> Option<f64> {
        let first = self.simple_number()?;
        let after_first = self.pos;
        // Mixed number "1 1/2" — the second part must be a proper fraction.
        for sep in [" ", "-", " - "] {
            if let Some(after) = self.rest().strip_prefix(sep) {
                let mut probe = Cursor {
                    s: self.s,
                    pos: self.pos + sep.len(),
                };
                if after.contains('/')
                    && let Some(frac) = probe.fraction_only()
                    && frac < 1.0
                    && first.fract() == 0.0
                {
                    self.pos = probe.pos;
                    return Some(first + frac);
                }
            }
        }
        self.pos = after_first;
        Some(first)
    }

    /// Parses strictly "a/b".
    fn fraction_only(&mut self) -> Option<f64> {
        let save = self.pos;
        let num = self.decimal();
        if let Some(num) = num
            && self.rest().starts_with('/')
        {
            self.pos += 1;
            if let Some(den) = self.decimal()
                && den != 0.0
            {
                return Some(num / den);
            }
        }
        self.pos = save;
        None
    }

    /// Parses an optional range tail ("-4", " - 4", " to 4", " or 4"), discarding it.
    fn skip_range_tail(&mut self) {
        let save = self.pos;
        let rest = self.rest();
        for sep in ["-", " - ", "–", " – ", " to ", " or "] {
            if let Some(after) = rest.strip_prefix(sep)
                && after.starts_with(|c: char| c.is_ascii_digit())
            {
                self.pos += sep.len();
                if self.number().is_some() {
                    return;
                }
                self.pos = save;
            }
        }
    }

    /// Consumes a unit (one or two words) if recognised.
    fn unit(&mut self) -> Option<&'static str> {
        self.skip_spaces();
        let rest = self.rest();
        // Two-word units first ("fl oz", "bar spoon").
        let words: Vec<&str> = rest.splitn(3, ' ').collect();
        if words.len() >= 2 {
            let two_len = words[0].len() + 1 + words[1].len();
            if let Some(u) = canonical_unit(&rest[..two_len]) {
                self.pos += two_len;
                return Some(u);
            }
        }
        // Unit glued to the number ("175g", "2cl") or a plain word.
        let word_len = rest
            .find(|c: char| !(c.is_ascii_alphabetic() || c == '.'))
            .unwrap_or(rest.len());
        if word_len == 0 {
            return None;
        }
        let word = &rest[..word_len];
        if let Some(u) = canonical_unit(word) {
            self.pos += word_len;
            return Some(u);
        }
        None
    }
}

/// Words describing "no specific amount".
fn is_unquantified(lower: &str) -> bool {
    const PHRASES: [&str; 10] = [
        "top up",
        "top",
        "to top",
        "fill",
        "to taste",
        "garnish",
        "as needed",
        "to serve",
        "for garnish",
        "optional",
    ];
    PHRASES
        .iter()
        .any(|p| lower == *p || lower.starts_with(&format!("{p} ")))
}

/// Parses an upstream measure. Unparsable measures keep the raw text in `note`.
pub fn parse_measure(raw: &str) -> Measure {
    let original = expand_unicode_fractions(raw.trim());
    if original.is_empty() {
        return Measure {
            amount: None,
            unit: String::new(),
            note: String::new(),
        };
    }
    // ASCII lowercase keeps byte offsets aligned with `original`.
    let lower = original.to_ascii_lowercase();

    if is_unquantified(&lower) {
        return Measure::unparsed(&original);
    }

    // "Juice of 1", "Juice of 1/2 lemon", "Zest of 1".
    for prefix in ["juice of ", "zest of ", "peel of "] {
        if let Some(after) = lower.strip_prefix(prefix) {
            let mut c = Cursor {
                s: &lower,
                pos: prefix.len(),
            };
            if after.starts_with(|ch: char| ch.is_ascii_digit())
                && let Some(n) = c.number().filter(|a| is_sane_amount(*a))
            {
                c.skip_range_tail();
                let mut note = prefix.trim_end_matches(" of ").to_owned();
                let tail = original[c.pos..].trim();
                if !tail.is_empty() {
                    note = format!("{note} ({tail})");
                }
                return Measure {
                    amount: Some(n),
                    unit: String::new(),
                    note,
                };
            }
        }
    }

    // "A dash", "a splash of", "dash".
    let mut c = Cursor { s: &lower, pos: 0 };
    let article = ["a ", "an "].iter().find(|a| lower.starts_with(**a));
    if let Some(a) = article {
        c.pos = a.len();
    }
    if !lower.starts_with(|ch: char| ch.is_ascii_digit()) {
        if let Some(u) = c.unit() {
            let tail = tidy_tail(&original[c.pos..]);
            return Measure {
                amount: Some(1.0),
                unit: u.to_owned(),
                note: tail,
            };
        }
        return Measure::unparsed(&original);
    }

    // Absurd amounts ("99999…9", "1/0.0001") would be rejected by recipe
    // validation later, so keep them as raw text instead.
    let Some(amount) = c.number().filter(|a| is_sane_amount(*a)) else {
        return Measure::unparsed(&original);
    };
    c.skip_range_tail();
    let unit = c.unit().unwrap_or("");
    let note = tidy_tail(&original[c.pos..]);
    Measure {
        amount: Some(amount),
        unit: unit.to_owned(),
        note,
    }
}

/// Same bounds as `Ingredient.amount` validation on recipe save.
fn is_sane_amount(a: f64) -> bool {
    a.is_finite() && (0.0..=MAX_AMOUNT).contains(&a)
}

/// Cleans up the remainder after amount/unit ("of", stray punctuation).
fn tidy_tail(tail: &str) -> String {
    let t = tail.trim().trim_start_matches(['.', ',', ')']).trim();
    let t = t
        .strip_prefix("of ")
        .or_else(|| t.strip_prefix("Of "))
        .unwrap_or(t);
    let t = if t.eq_ignore_ascii_case("of") { "" } else { t };
    t.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> (Option<f64>, String, String) {
        let m = parse_measure(s);
        (m.amount, m.unit, m.note)
    }

    fn approx(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-9)
    }

    #[test]
    fn mixed_numbers_and_fractions() {
        let (a, u, n) = p("1 1/2 oz");
        assert!(approx(a, 1.5));
        assert_eq!((u.as_str(), n.as_str()), ("oz", ""));
        let (a, u, _) = p("1/2");
        assert!(approx(a, 0.5));
        assert_eq!(u, "");
        let (a, u, _) = p("3/4 oz ");
        assert!(approx(a, 0.75));
        assert_eq!(u, "oz");
        let (a, u, _) = p("1-1/2 oz");
        assert!(approx(a, 1.5));
        assert_eq!(u, "oz");
        let (a, u, _) = p("1½ oz");
        assert!(approx(a, 1.5));
        assert_eq!(u, "oz");
        let (a, _, _) = p("¼ tsp");
        assert!(approx(a, 0.25));
        let (a, u, _) = p("2 1/2 cups");
        assert!(approx(a, 2.5));
        assert_eq!(u, "cup");
    }

    #[test]
    fn metric_units() {
        assert_eq!(p("2 cl"), (Some(2.0), "cl".into(), "".into()));
        assert_eq!(p("175g"), (Some(175.0), "g".into(), "".into()));
        assert_eq!(p("500 ml"), (Some(500.0), "ml".into(), "".into()));
        assert_eq!(p("1.5 l"), (Some(1.5), "l".into(), "".into()));
        assert_eq!(p("0,5 L"), (Some(0.5), "l".into(), "".into()));
        assert_eq!(p("1kg"), (Some(1.0), "kg".into(), "".into()));
        assert_eq!(p("2 Cl"), (Some(2.0), "cl".into(), "".into()));
    }

    #[test]
    fn ranges_take_lower_bound() {
        assert_eq!(p("3-4 dashes"), (Some(3.0), "dash".into(), "".into()));
        assert_eq!(p("2 - 3 drops"), (Some(2.0), "drop".into(), "".into()));
        assert_eq!(p("1 or 2 tsp"), (Some(1.0), "tsp".into(), "".into()));
        assert_eq!(p("4 to 6 leaves"), (Some(4.0), "leaf".into(), "".into()));
    }

    #[test]
    fn unit_normalisation() {
        assert_eq!(p("1 tblsp"), (Some(1.0), "tbsp".into(), "".into()));
        assert_eq!(p("2 tbs"), (Some(2.0), "tbsp".into(), "".into()));
        assert_eq!(p("1 tablespoon"), (Some(1.0), "tbsp".into(), "".into()));
        assert_eq!(p("2 shots"), (Some(2.0), "shot".into(), "".into()));
        assert_eq!(p("1 shot"), (Some(1.0), "shot".into(), "".into()));
        assert_eq!(p("2 dashes"), (Some(2.0), "dash".into(), "".into()));
        assert_eq!(p("1 tsp"), (Some(1.0), "tsp".into(), "".into()));
        assert_eq!(p("3 teaspoons"), (Some(3.0), "tsp".into(), "".into()));
        assert_eq!(p("1 fl oz"), (Some(1.0), "oz".into(), "".into()));
        assert_eq!(p("2 Ounces"), (Some(2.0), "oz".into(), "".into()));
        assert_eq!(p("1 bar spoon"), (Some(1.0), "barspoon".into(), "".into()));
        assert_eq!(p("2 cloves"), (Some(2.0), "clove".into(), "".into()));
        assert_eq!(p("1 lb"), (Some(1.0), "lb".into(), "".into()));
        assert_eq!(p("1 jigger"), (Some(1.0), "jigger".into(), "".into()));
        assert_eq!(p("2 parts"), (Some(2.0), "part".into(), "".into()));
    }

    #[test]
    fn remainder_goes_to_note() {
        assert_eq!(p("1 oz white"), (Some(1.0), "oz".into(), "white".into()));
        assert_eq!(p("2 large"), (Some(2.0), "".into(), "large".into()));
        assert_eq!(
            p("1 cup of sugar"),
            (Some(1.0), "cup".into(), "sugar".into())
        );
        assert_eq!(p("1 tall"), (Some(1.0), "".into(), "tall".into()));
        assert_eq!(
            p("2 tbsp chopped"),
            (Some(2.0), "tbsp".into(), "chopped".into())
        );
    }

    #[test]
    fn juice_of() {
        assert_eq!(p("Juice of 1"), (Some(1.0), "".into(), "juice".into()));
        let (a, u, n) = p("Juice of 1/2");
        assert!(approx(a, 0.5));
        assert_eq!((u.as_str(), n.as_str()), ("", "juice"));
        assert_eq!(
            p("juice of 1 lemon"),
            (Some(1.0), "".into(), "juice (lemon)".into())
        );
        assert_eq!(p("Zest of 2"), (Some(2.0), "".into(), "zest".into()));
    }

    #[test]
    fn unquantified_keeps_raw_note() {
        assert_eq!(p("top up"), (None, "".into(), "top up".into()));
        assert_eq!(p("Top up"), (None, "".into(), "Top up".into()));
        assert_eq!(p("Fill"), (None, "".into(), "Fill".into()));
        assert_eq!(p("to taste"), (None, "".into(), "to taste".into()));
        assert_eq!(p("Garnish with"), (None, "".into(), "Garnish with".into()));
        assert_eq!(p("Some"), (None, "".into(), "Some".into()));
        assert_eq!(p(""), (None, "".into(), "".into()));
        assert_eq!(p("   "), (None, "".into(), "".into()));
    }

    #[test]
    fn bare_units_mean_one() {
        assert_eq!(p("Dash"), (Some(1.0), "dash".into(), "".into()));
        assert_eq!(p("a splash of"), (Some(1.0), "splash".into(), "".into()));
        assert_eq!(p("Pinch"), (Some(1.0), "pinch".into(), "".into()));
        assert_eq!(
            p("A pinch salt"),
            (Some(1.0), "pinch".into(), "salt".into())
        );
    }

    #[test]
    fn plain_numbers() {
        assert_eq!(p("2"), (Some(2.0), "".into(), "".into()));
        assert_eq!(p("12"), (Some(12.0), "".into(), "".into()));
        assert_eq!(p("1/0"), (Some(1.0), "".into(), "/0".into()));
    }

    #[test]
    fn absurd_amounts_stay_raw() {
        let huge = "9".repeat(400);
        assert_eq!(p(&huge), (None, "".into(), huge.clone()));
        let (a, _, n) = p("1/0.0000001 oz");
        assert_eq!((a, n.as_str()), (None, "1/0.0000001 oz"));
        let raw = format!("Juice of {huge}");
        assert_eq!(p(&raw).0, None);
    }
}
