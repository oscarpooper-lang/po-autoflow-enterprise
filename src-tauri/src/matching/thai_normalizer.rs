use regex::Regex;

pub struct ThaiNormalizer;

impl ThaiNormalizer {
    /// Normalizes Unicode representations of Thai characters, repairs AX2012 Tahoma GID shifts,
    /// PUA presentation forms, broken space+Sara Aa words, removes zero-width chars,
    /// and unifies Sara Am representations.
    pub fn normalize_unicode(text: &str) -> String {
        let mut repaired = String::with_capacity(text.len());
        for ch in text.chars() {
            let cp = ch as u32;
            let mapped = if (0x0434..=0x046D).contains(&cp) {
                char::from_u32(cp + 0x09CD).unwrap_or(ch)
            } else if (0x046F..=0x047B).contains(&cp) {
                char::from_u32(cp + 0x09D1).unwrap_or(ch)
            } else if cp == 0x047C {
                '\u{0E33}'
            } else if (0x0495..=0x0499).contains(&cp) {
                char::from_u32(cp + 0x09B3).unwrap_or(ch)
            } else if (0x049E..=0x04A2).contains(&cp) {
                char::from_u32(cp + 0x09AA).unwrap_or(ch)
            } else {
                match cp {
                    0xF700 => '\u{0E10}',
                    0xF701..=0xF704 => char::from_u32(cp - 0xF701 + 0x0E34).unwrap_or(ch),
                    0xF705..=0xF709 => char::from_u32(cp - 0xF705 + 0x0E48).unwrap_or(ch),
                    0xF70A..=0xF70E => char::from_u32(cp - 0xF70A + 0x0E48).unwrap_or(ch),
                    0xF70F => '\u{0E0D}',
                    0xF710 => '\u{0E31}',
                    0xF711 => '\u{0E4D}',
                    0xF712 => '\u{0E47}',
                    0xF713..=0xF717 => char::from_u32(cp - 0xF713 + 0x0E48).unwrap_or(ch),
                    0xF718..=0xF71A => char::from_u32(cp - 0xF718 + 0x0E38).unwrap_or(ch),
                    _ => ch,
                }
            };
            repaired.push(mapped);
        }

        // Replace Nikhahit + Sara Aa (U+0E4D + U+0E32) and redundant Sara Am+Aa (U+0E33 + U+0E32) with Sara Am (U+0E33)
        let mut s = repaired.replace("\u{0E4D}\u{0E32}", "\u{0E33}");
        s = s.replace("\u{0E33}\u{0E32}", "\u{0E33}");

        // Fix GDI/Word PDF broken space + Sara Aa in common Thai words
        let broken_sara_am = [
            (r"จ\s+ากัด", "จำกัด"),
            (r"ส\s+านักงาน", "สำนักงาน"),
            (r"ส\s+าเนา", "สำเนา"),
            (r"ล\s+าดับ", "ลำดับ"),
            (r"จ\s+านวน", "จำนวน"),
            (r"ก\s+าหนด", "กำหนด"),
            (r"ก\s+ากับ", "กำกับ"),
            (r"ช\s+าระ", "ชำระ"),
            (r"ต\s+าบล", "ตำบล"),
            (r"อ\s+าเภอ", "อำเภอ"),
            (r"ประจ\s+า", "ประจำ"),
        ];
        for (pat, repl) in broken_sara_am {
            if let Ok(re) = Regex::new(pat) {
                s = re.replace_all(&s, repl).to_string();
            }
        }

        // Remove zero-width characters and soft hyphens
        s = s
            .replace('\u{200B}', "")
            .replace('\u{200C}', "")
            .replace('\u{200D}', "")
            .replace('\u{FEFF}', "")
            .replace('\u{00AD}', "");

        // Collapse multiple whitespaces
        let ws_re = Regex::new(r"\s+").unwrap();
        ws_re.replace_all(&s, " ").trim().to_string()
    }

    /// Returns true if the text refers to the buyer / self-company (QTC Energy PCL)
    /// or generic document noise that must never be matched as a supplier.
    pub fn is_ignored_self_company(text: &str) -> bool {
        let low = Self::normalize_unicode(text).to_lowercase();
        let ignored_keywords = [
            "qtc energy",
            "qtc(",
            "qtc ",
            " qtc",
            "คิวทีซี",
            "โรงงานระยอง",
            "krungthep kritha",
            "pluakdaeng",
            "mabyangporn",
            "ปลวกแดง",
            "มาบยางพร",
            "กรุงเทพกรีฑา",
            "0107553000158",
            "qa inc",
            "incoming pass",
            "purchase order",
        ];
        if low == "qtc" || ignored_keywords.iter().any(|k| low.contains(k)) {
            return true;
        }
        false
    }

    /// Strips company prefixes and suffixes to isolate the root company entity name.
    /// E.g. "บริษัท เอบีซี เทรดดิ้ง จำกัด" -> "เอบีซี เทรดดิ้ง"
    /// E.g. "PASINSOOK LIMITED PARTNERSHIP" -> "pasinsook"
    pub fn clean_company_name(text: &str) -> String {
        let norm = Self::normalize_unicode(text);
        let mut lower = norm.to_lowercase();

        // Strip trailing head office / branch labels so main office & branch docs share one key
        if let Ok(branch_re) = Regex::new(
            r"(?i)(?:\(?\s*สำนักงานใหญ่\s*\)?|\(?\s*head\s*office\s*\)?|\(?\s*สาขา(?:ที่)?\s*\d*\s*\)?|\(?\s*\bbranch\s*(?:no\.?\s*)?\d*\s*\)?)",
        ) {
            lower = branch_re.replace_all(&lower, " ").trim().to_string();
        }

        // Strip Thai prefixes
        let thai_prefixes = [
            "บริษัทจำกัด(มหาชน)",
            "บริษัทจำกัด (มหาชน)",
            "บริษัทมหาชนจำกัด",
            "บริษัท มหาชน จำกัด",
            "บริษัท",
            "บจก.",
            "บจก",
            "บ.จำกัด",
            "ห้างหุ้นส่วนจำกัด",
            "ห้างหุ้นส่วนสามัญ",
            "หจก.",
            "หจก",
            "หสน.",
            "หสน",
        ];

        for prefix in thai_prefixes {
            if lower.starts_with(prefix) {
                lower = lower[prefix.len()..].trim().to_string();
                break;
            }
        }

        // Strip Thai suffixes (support chained suffixes like จำกัด (มหาชน))
        let thai_suffixes = [
            "จำกัด (มหาชน)",
            "จำกัด(มหาชน)",
            "มหาชน จำกัด",
            "มหาชนจำกัด",
            "(มหาชน)",
            "มหาชน",
            "จำกัด",
        ];

        let mut changed = true;
        while changed {
            changed = false;
            for suffix in &thai_suffixes {
                if lower.ends_with(suffix) {
                    lower = lower[..lower.len() - suffix.len()].trim().to_string();
                    changed = true;
                    break;
                }
            }
        }

        // Strip English & international legal suffixes (longest multi-word suffixes first, boundary-safe)
        let eng_suffixes = [
            "public company limited",
            "limited partnership",
            "ltd., part.",
            "ltd. part.",
            "ltd part",
            "company limited",
            "co., ltd.",
            "co., ltd",
            "co. ltd.",
            "co. ltd",
            "co ltd",
            "pte. ltd.",
            "pte ltd",
            "pty. ltd.",
            "pty ltd",
            "sdn. bhd.",
            "sdn bhd",
            "limited",
            "ltd.",
            "ltd",
            "corporation",
            "corp.",
            "corp",
            "incorporated",
            "inc.",
            "inc",
            "gmbh",
            "l.l.c.",
            "llc",
            "llp",
            "plc.",
            "plc",
            "pcl.",
            "pcl",
            "s.a.",
            "k.k.",
            "b.v.",
            "ag",
            "ab",
        ];

        let mut eng_changed = true;
        while eng_changed {
            eng_changed = false;
            for suffix in &eng_suffixes {
                if lower.ends_with(suffix) {
                    let prefix_end = lower.len() - suffix.len();
                    let boundary_ok = prefix_end == 0
                        || lower[..prefix_end]
                            .chars()
                            .next_back()
                            .map(|ch| !ch.is_alphanumeric())
                            .unwrap_or(true);
                    if boundary_ok {
                        lower = lower[..prefix_end].trim_end_matches(|ch: char| ch.is_whitespace() || ch == ',').trim().to_string();
                        eng_changed = true;
                        break;
                    }
                }
            }
        }

        // Remove extraneous punctuation (parentheses, dots, commas, hyphens)
        let punct_re = Regex::new(r#"[.,\-–—()\[\]{}'"/\\#]"#).unwrap();
        let cleaned = punct_re.replace_all(&lower, " ").trim().to_string();

        let ws_re = Regex::new(r"\s+").unwrap();
        ws_re.replace_all(&cleaned, " ").trim().to_string()
    }

    /// Returns true if string contains Thai Unicode characters (U+0E00..=U+0E7F).
    pub fn contains_thai(text: &str) -> bool {
        text.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c))
    }

    /// Transliterates Thai script into rough RTGS Latin phonetics while keeping ASCII text lowercased.
    /// Useful for cross-script matching (e.g. "พศินสุข" <-> "PASINSOOK").
    pub fn romanize_thai(text: &str) -> String {
        let cleaned = Self::clean_company_name(text);
        let mut out = String::with_capacity(cleaned.len() * 2);
        for ch in cleaned.chars() {
            match ch {
                'ก' => out.push('k'),
                'ข' | 'ฃ' | 'ค' | 'ฅ' | 'ฆ' => out.push('k'),
                'ง' => out.push_str("ng"),
                'จ' | 'ฉ' | 'ช' | 'ฌ' => out.push_str("ch"),
                'ซ' | 'ศ' | 'ษ' | 'ส' => out.push('s'),
                'ญ' | 'ย' => out.push('y'),
                'ฎ' | 'ด' => out.push('d'),
                'ฏ' | 'ต' | 'ฐ' | 'ฑ' | 'ฒ' | 'ถ' | 'ท' | 'ธ' => out.push('t'),
                'ณ' | 'น' => out.push('n'),
                'บ' => out.push('b'),
                'ป' | 'ผ' | 'พ' | 'ภ' => out.push('p'),
                'ฝ' | 'ฟ' => out.push('f'),
                'ม' => out.push('m'),
                'ร' => out.push('r'),
                'ล' | 'ฬ' => out.push('l'),
                'ว' => out.push('w'),
                'ห' | 'ฮ' => out.push('h'),
                'อ' => {}
                'ะ' | 'ั' | 'า' => out.push('a'),
                'ำ' => out.push_str("am"),
                'ิ' | 'ี' => out.push('i'),
                'ึ' | 'ื' | 'ุ' | 'ู' => out.push('u'),
                'เ' | 'แ' => out.push('e'),
                'โ' => out.push('o'),
                'ใ' | 'ไ' => out.push_str("ai"),
                '่' | '้' | '๊' | '๋' | '์' | '็' | 'ๆ' => {}
                'a'..='z' | '0'..='9' | ' ' => out.push(ch),
                _ => {}
            }
        }
        let ws_re = Regex::new(r"\s+").unwrap();
        ws_re.replace_all(&out, " ").trim().to_string()
    }

    /// Produces a cross-script consonant phonetic skeleton so Thai names and English transliterations
    /// ("พศินสุข" vs "PASINSOOK") converge to the same consonant sequence ("psnsk").
    pub fn phonetic_skeleton(text: &str) -> String {
        let mut rom = Self::romanize_thai(text);
        // Collapse common English digraph transliterations to match Thai single consonants
        for (digraph, rep) in [
            ("ph", "p"),
            ("th", "t"),
            ("kh", "k"),
            ("ch", "j"),
            ("sh", "s"),
            ("oo", "u"),
            ("ee", "i"),
            ("qu", "k"),
            ("ck", "k"),
        ] {
            rom = rom.replace(digraph, rep);
        }

        let mut skel = String::with_capacity(rom.len());
        let mut prev: Option<char> = None;
        for ch in rom.chars() {
            let mapped = match ch {
                'a' | 'e' | 'i' | 'o' | 'u' | ' ' | 'h' => continue,
                'c' | 'q' => 'k',
                'v' => 'w',
                'z' => 's',
                _ if ch.is_ascii_alphanumeric() => ch,
                _ => continue,
            };
            if Some(mapped) != prev {
                skel.push(mapped);
                prev = Some(mapped);
            }
        }
        skel
    }
}
