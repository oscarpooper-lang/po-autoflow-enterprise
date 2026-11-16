pub mod thai_normalizer;

use std::collections::HashSet;
use thai_normalizer::ThaiNormalizer;
use crate::database::models::{CompanyAlias, CompanyCacheEntry};

#[derive(Debug, Clone)]
pub struct MatchResult {
    pub query: String,
    pub matched_company: Option<CompanyCacheEntry>,
    pub confidence: f64,
    pub category: String, // "verified", "high", "review", "no_match"
    pub is_ambiguous: bool,
    pub matched_by: String, // "alias", "exact_name", "alternative_name", "token_similarity"
}

pub struct CompanyMatcher;

impl CompanyMatcher {
    /// Computes classic Levenshtein distance between two strings.
    pub fn levenshtein(s1: &str, s2: &str) -> usize {
        let v1: Vec<char> = s1.chars().collect();
        let v2: Vec<char> = s2.chars().collect();
        let len1 = v1.len();
        let len2 = v2.len();

        if len1 == 0 {
            return len2;
        }
        if len2 == 0 {
            return len1;
        }

        let mut matrix = vec![vec![0; len2 + 1]; len1 + 1];
        for i in 0..=len1 {
            matrix[i][0] = i;
        }
        for j in 0..=len2 {
            matrix[0][j] = j;
        }

        for i in 1..=len1 {
            for j in 1..=len2 {
                let cost = if v1[i - 1] == v2[j - 1] { 0 } else { 1 };
                matrix[i][j] = std::cmp::min(
                    std::cmp::min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1),
                    matrix[i - 1][j - 1] + cost,
                );
            }
        }

        matrix[len1][len2]
    }

    /// Computes similarity ratio as a percentage (0.0 to 100.0).
    pub fn similarity_ratio(s1: &str, s2: &str) -> f64 {
        if s1 == s2 {
            return 100.0;
        }
        let max_len = s1.chars().count().max(s2.chars().count());
        if max_len == 0 {
            return 100.0;
        }
        let dist = Self::levenshtein(s1, s2);
        let ratio = 1.0 - (dist as f64 / max_len as f64);
        (ratio * 100.0).max(0.0)
    }

    /// Computes Token Sort Ratio (orders words alphabetically before comparing).
    pub fn token_sort_ratio(s1: &str, s2: &str) -> f64 {
        let mut tokens1: Vec<&str> = s1.split_whitespace().collect();
        let mut tokens2: Vec<&str> = s2.split_whitespace().collect();

        tokens1.sort();
        tokens2.sort();

        let sorted1 = tokens1.join(" ");
        let sorted2 = tokens2.join(" ");

        Self::similarity_ratio(&sorted1, &sorted2)
    }

    /// Computes Token Set Ratio (handles common intersection of words).
    pub fn token_set_ratio(s1: &str, s2: &str) -> f64 {
        let set1: HashSet<&str> = s1.split_whitespace().collect();
        let set2: HashSet<&str> = s2.split_whitespace().collect();

        let mut intersection: Vec<&str> = set1.intersection(&set2).cloned().collect();
        if intersection.is_empty() {
            return Self::similarity_ratio(s1, s2);
        }

        intersection.sort();
        let inter_str = intersection.join(" ");
        let ratio_with_s1 = Self::token_sort_ratio(&inter_str, s1);
        let ratio_with_s2 = Self::token_sort_ratio(&inter_str, s2);
        let base_ratio = Self::similarity_ratio(s1, s2);

        ratio_with_s1.max(ratio_with_s2).max(base_ratio)
    }

    /// Matches an extracted company name against the directory and custom aliases.
    /// Supports exact, token sort/set, and Thai-to-English phonetic cross-script matching.
    pub fn match_company(
        query: &str,
        directory: &[CompanyCacheEntry],
        aliases: &[CompanyAlias],
        verified_threshold: f64,
        high_threshold: f64,
        review_threshold: f64,
    ) -> MatchResult {
        if query.trim().is_empty() || ThaiNormalizer::is_ignored_self_company(query) {
            return MatchResult {
                query: query.to_string(),
                matched_company: None,
                confidence: 0.0,
                category: "no_match".to_string(),
                is_ambiguous: false,
                matched_by: "ignored_self_company".to_string(),
            };
        }

        let norm_query = ThaiNormalizer::normalize_unicode(query);
        let clean_query = ThaiNormalizer::clean_company_name(&norm_query);
        let query_has_thai = ThaiNormalizer::contains_thai(&clean_query);
        let query_rom = ThaiNormalizer::romanize_thai(&clean_query);
        let query_skel = ThaiNormalizer::phonetic_skeleton(&clean_query);

        // 1. Check custom aliases first (user verified manual corrections)
        for alias in aliases {
            let norm_alias = ThaiNormalizer::clean_company_name(&alias.alias);
            if norm_alias == clean_query || Self::similarity_ratio(&norm_alias, &clean_query) >= 95.0 {
                // Find canonical company in directory
                if let Some(target) = directory.iter().find(|c| {
                    c.active
                        && (ThaiNormalizer::clean_company_name(&c.company_name)
                            == ThaiNormalizer::clean_company_name(&alias.canonical_company_name)
                            || c.company_name == alias.canonical_company_name)
                }) {
                    return MatchResult {
                        query: query.to_string(),
                        matched_company: Some(target.clone()),
                        confidence: 100.0,
                        category: "verified".to_string(),
                        is_ambiguous: false,
                        matched_by: "alias".to_string(),
                    };
                }
            }
        }

        let score_against = |target_raw: &str| -> f64 {
            let clean_target = ThaiNormalizer::clean_company_name(target_raw);
            if clean_target.is_empty() {
                return 0.0;
            }
            let same_script_score = Self::token_sort_ratio(&clean_query, &clean_target)
                .max(Self::token_set_ratio(&clean_query, &clean_target));

            let target_has_thai = ThaiNormalizer::contains_thai(&clean_target);
            if query_has_thai != target_has_thai && query_skel.len() >= 4 {
                let target_rom = ThaiNormalizer::romanize_thai(&clean_target);
                let target_skel = ThaiNormalizer::phonetic_skeleton(&clean_target);
                if target_skel.len() >= 4 {
                    if query_skel == target_skel {
                        return same_script_score.max(94.0);
                    }
                    let skel_sim = Self::similarity_ratio(&query_skel, &target_skel);
                    let rom_sim = Self::token_set_ratio(&query_rom, &target_rom);
                    let phonetic = (skel_sim.max(rom_sim) * 0.94).min(93.5);
                    if phonetic >= 75.0 {
                        return same_script_score.max(phonetic);
                    }
                }
            }
            same_script_score
        };

        // 2. Score against all active companies in directory
        let mut scored_candidates: Vec<(&CompanyCacheEntry, f64, &'static str)> = Vec::new();

        for company in directory.iter().filter(|c| c.active) {
            if ThaiNormalizer::is_ignored_self_company(&company.company_name) {
                continue;
            }
            let score_name = score_against(&company.company_name);

            let mut best_score = score_name;
            let mut matched_field = "company_name";

            if let Some(ref alt) = company.alternative_name {
                let score_alt = score_against(alt);
                if score_alt > best_score {
                    best_score = score_alt;
                    matched_field = "alternative_name";
                }
            }

            if best_score > 40.0 {
                scored_candidates.push((company, best_score, matched_field));
            }
        }

        // Sort descending by score
        scored_candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        if scored_candidates.is_empty() {
            return MatchResult {
                query: query.to_string(),
                matched_company: None,
                confidence: 0.0,
                category: "no_match".to_string(),
                is_ambiguous: false,
                matched_by: "none".to_string(),
            };
        }

        let (best_company, best_score, matched_field) = scored_candidates[0];

        // Check ambiguity: if second candidate is within 3% of the best score
        let is_ambiguous = if scored_candidates.len() > 1 {
            let second_score = scored_candidates[1].1;
            (best_score - second_score).abs() < 3.0 && best_score < 99.0
        } else {
            false
        };

        // Determine category based on calibrated enterprise thresholds
        let category = if is_ambiguous {
            "review"
        } else if best_score >= verified_threshold {
            "verified"
        } else if best_score >= high_threshold {
            "high"
        } else if best_score >= review_threshold {
            "review"
        } else {
            "no_match"
        };

        MatchResult {
            query: query.to_string(),
            matched_company: Some(best_company.clone()),
            confidence: (best_score * 10.0).round() / 10.0,
            category: category.to_string(),
            is_ambiguous,
            matched_by: matched_field.to_string(),
        }
    }

    /// Evaluates all extracted supplier candidates (skipping buyer/QTC names), preferring Thai name
    /// in `MatchResult.query` while evaluating both Thai & English candidates against the directory.
    pub fn match_candidates(
        candidates: &[crate::ocr::SupplierCandidate],
        directory: &[CompanyCacheEntry],
        aliases: &[CompanyAlias],
        verified_threshold: f64,
        high_threshold: f64,
        review_threshold: f64,
    ) -> MatchResult {
        let valid: Vec<&crate::ocr::SupplierCandidate> = candidates
            .iter()
            .filter(|c| !ThaiNormalizer::is_ignored_self_company(&c.name))
            .collect();

        if valid.is_empty() {
            return MatchResult {
                query: String::new(),
                matched_company: None,
                confidence: 0.0,
                category: "no_match".to_string(),
                is_ambiguous: false,
                matched_by: "none".to_string(),
            };
        }

        // Preserve Thai name first for display/learning if any Thai candidate exists
        let preferred_query = valid
            .iter()
            .find(|c| c.language == "th")
            .or_else(|| valid.first())
            .map(|c| ThaiNormalizer::normalize_unicode(&c.name))
            .unwrap_or_default();

        let mut best_result: Option<(MatchResult, bool)> = None;
        for cand in &valid {
            let res = Self::match_company(
                &cand.name,
                directory,
                aliases,
                verified_threshold,
                high_threshold,
                review_threshold,
            );
            let is_th = cand.language == "th";
            let replace = match &best_result {
                None => true,
                Some((curr, curr_th)) => {
                    res.confidence > curr.confidence
                        || ((res.confidence - curr.confidence).abs() < 0.01 && is_th && !curr_th)
                }
            };
            if replace {
                best_result = Some((res, is_th));
            }
        }

        let mut chosen = best_result.map(|(r, _)| r).unwrap();
        if !preferred_query.is_empty() {
            chosen.query = preferred_query;
        }
        chosen
    }
}

