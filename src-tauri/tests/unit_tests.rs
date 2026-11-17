use app_lib::archive::ArchiveManager;
use app_lib::database::models::*;
use app_lib::database::Database;
use app_lib::email::EmailDeliveryClient;
use app_lib::matching::thai_normalizer::ThaiNormalizer;
use app_lib::matching::CompanyMatcher;
use app_lib::security::SecurityManager;
use std::fs::File;
use std::io::Write;
use tempfile::tempdir;

#[test]
fn test_thai_unicode_and_company_normalization() {
    // Test 1: Sara Am unification
    let raw = "บริษัท\u{0E4D}\u{0E32} เอบีซี จำกัด";
    let normalized = ThaiNormalizer::normalize_unicode(raw);
    assert!(!normalized.contains('\u{0E4D}'));

    // Test 2: Stripping prefixes and suffixes to find canonical root
    let comp1 = "บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด";
    let cleaned1 = ThaiNormalizer::clean_company_name(comp1);
    assert_eq!(cleaned1, "สยาม ซัพพลาย แอนด์ เทรดดิ้ง");

    let comp2 = "SIAM SUPPLY & TRADING CO., LTD.";
    let cleaned2 = ThaiNormalizer::clean_company_name(comp2);
    assert_eq!(cleaned2, "siam supply & trading");

    // Test 3: Public company limited
    let comp3 = "บริษัท บางกอก ออโตเมชั่น จำกัด (มหาชน)";
    let cleaned3 = ThaiNormalizer::clean_company_name(comp3);
    assert_eq!(cleaned3, "บางกอก ออโตเมชั่น");
}

#[test]
fn test_token_similarity_algorithms() {
    // Identical
    assert_eq!(CompanyMatcher::similarity_ratio("abc", "abc"), 100.0);

    // Token Sort Ratio: Word order reversed should match near 100%
    let s1 = "siam supply trading";
    let s2 = "trading siam supply";
    let sort_score = CompanyMatcher::token_sort_ratio(s1, s2);
    assert!(sort_score >= 99.0, "Expected >=99, got {}", sort_score);

    // Token Set Ratio: Subset of words should match highly
    let query = "siam supply";
    let target = "siam supply and logistics group";
    let set_score = CompanyMatcher::token_set_ratio(query, target);
    assert!(set_score >= 90.0, "Expected >=90, got {}", set_score);
}

#[test]
fn test_intelligent_company_matching_with_confidence_categories() {
    let directory = vec![
        CompanyCacheEntry {
            id: "1".to_string(),
            company_name: "บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด".to_string(),
            alternative_name: Some("SIAM SUPPLY & TRADING CO., LTD.".to_string()),
            email: "billing@siamsupply.co.th".to_string(),
            active: true,
            tax_id: Some("0105556012345".to_string()),
            notes: None,
            vendor_group: Some("DV".to_string()),
            synced_at: "2026-11-12T00:00:00Z".to_string(),
        },
        CompanyCacheEntry {
            id: "2".to_string(),
            company_name: "บริษัท ไทย อินดัสเทรียล จำกัด".to_string(),
            alternative_name: Some("THAI INDUSTRIAL CO., LTD.".to_string()),
            email: "orders@thaiindustrial.com".to_string(),
            active: true,
            tax_id: None,
            notes: None,
            vendor_group: Some("DV".to_string()),
            synced_at: "2026-11-12T00:00:00Z".to_string(),
        },
    ];

    let aliases = vec![
        CompanyAlias {
            id: "a1".to_string(),
            alias: "บจก. สยาม ซัพพลาย".to_string(),
            canonical_company_name: "บริษัท สยาม ซัพพลาย แอนด์ เทรดดิ้ง จำกัด".to_string(),
            created_by: "TEST".to_string(),
            created_at: "2026-11-12T00:00:00Z".to_string(),
        }
    ];

    // Case 1: Exact alias match -> must return 100% verified
    let res_alias = CompanyMatcher::match_company(
        "บจก. สยาม ซัพพลาย",
        &directory,
        &aliases,
        98.0,
        90.0,
        75.0,
    );
    assert_eq!(res_alias.confidence, 100.0);
    assert_eq!(res_alias.category, "verified");
    assert_eq!(res_alias.matched_company.unwrap().email, "billing@siamsupply.co.th");

    // Case 2: English name match
    let res_eng = CompanyMatcher::match_company(
        "SIAM SUPPLY & TRADING COMPANY LIMITED",
        &directory,
        &aliases,
        98.0,
        90.0,
        75.0,
    );
    assert!(res_eng.confidence >= 95.0);
    assert!(res_eng.category == "verified" || res_eng.category == "high");

    // Case 3: Unknown supplier -> no match
    let res_unknown = CompanyMatcher::match_company(
        "บริษัท โรงแรมและท่องเที่ยว เอ็กซ์เพรส จำกัด",
        &directory,
        &aliases,
        98.0,
        90.0,
        75.0,
    );
    assert_eq!(res_unknown.category, "no_match");
}

#[test]
fn test_email_validation() {
    assert!(EmailDeliveryClient::is_valid_email("billing@siamsupply.co.th"));
    assert!(EmailDeliveryClient::is_valid_email("procurement.office@domain.com"));
    assert!(EmailDeliveryClient::is_valid_email("ooo@email.com,aaa@gmail.com"));
    assert!(EmailDeliveryClient::is_valid_email("ooo@email.com; aaa@gmail.com , OOO@email.com "));
    assert_eq!(
        EmailDeliveryClient::normalize_recipient_list("ooo@email.com; aaa@gmail.com, OOO@EMAIL.COM").unwrap(),
        "ooo@email.com, aaa@gmail.com"
    );
    assert!(!EmailDeliveryClient::is_valid_email("ooo@email.com, bad-email"));
    assert!(!EmailDeliveryClient::is_valid_email(""));
    assert!(!EmailDeliveryClient::is_valid_email("not-an-email"));
    assert!(!EmailDeliveryClient::is_valid_email("user@nodomain"));
}

#[test]
fn test_archive_creation_and_integrity() {
    let tmp = tempdir().unwrap();
    let folder_to_zip = tmp.path().join("PO-TEST-001");
    std::fs::create_dir_all(&folder_to_zip).unwrap();

    let subfolder = folder_to_zip.join("SubDocs");
    std::fs::create_dir_all(&subfolder).unwrap();

    let mut f1 = File::create(folder_to_zip.join("Invoice.txt")).unwrap();
    f1.write_all(b"Synthetic Invoice Content for Testing").unwrap();

    let mut f2 = File::create(subfolder.join("Receipt.txt")).unwrap();
    f2.write_all(b"Synthetic Supporting Document").unwrap();

    let zip_output = tmp.path().join("PO-TEST-001.zip");

    let result = ArchiveManager::create_po_archive(&folder_to_zip, &zip_output, 25).unwrap();

    assert_eq!(result.file_count, 2);
    assert!(result.size_bytes > 0);
    assert_eq!(result.sha256_hash.len(), 64);
    assert!(zip_output.exists());
}

#[test]
fn test_security_path_traversal() {
    let tmp = tempdir().unwrap();
    let base = tmp.path();

    // Valid path inside base
    let valid = base.join("Incoming").join("PO-123");
    let check_valid = SecurityManager::validate_path_containment(base, &valid);
    assert!(check_valid.is_ok());

    // Path traversal attempt with ..
    let traversal = base.join("Incoming").join("..").join("..").join("Windows");
    let check_traversal = SecurityManager::validate_path_containment(base, &traversal);
    assert!(check_traversal.is_err());

    // UNC extended-prefix normalization (\\?\UNC\server\share -> \\server\share)
    let unc_resolved = SecurityManager::validate_path_containment(
        r"\\fileserver\PO-Share",
        r"\\?\UNC\fileserver\PO-Share\Incoming\PO-26004319\PO.pdf",
    )
    .expect("Extended UNC path inside UNC share should be accepted");
    assert_eq!(
        unc_resolved.to_string_lossy(),
        r"\\fileserver\PO-Share\Incoming\PO-26004319\PO.pdf"
    );

    let unc_escape = SecurityManager::validate_path_containment(
        r"\\fileserver\PO-Share",
        r"\\?\UNC\other-server\Other\secret.pdf",
    );
    assert!(unc_escape.is_err());
}

#[test]
fn test_database_duplicate_protection() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("test.db");
    let db = Database::new(&db_path).unwrap();

    let tx = PoTransaction {
        id: "tx-1".to_string(),
        job_id: "job-1".to_string(),
        po_number: "PO-26002323".to_string(),
        folder_fingerprint: "fp_test_123456789".to_string(),
        archive_sha256: "sha256_abcdef1234567890".to_string(),
        company_name: "Test Company".to_string(),
        recipient_email: "test@company.com".to_string(),
        status: "sent".to_string(),
        gas_execution_id: Some("exec-1".to_string()),
        error_message: None,
        sent_at: "2026-11-12T10:00:00Z".to_string(),
    };

    db.record_transaction(&tx).unwrap();

    // Check duplicate by PO number
    let dup_by_po = db.check_duplicate("PO-26002323", "fp_other", "sha_other").unwrap();
    assert!(dup_by_po.is_some());
    assert_eq!(dup_by_po.unwrap().id, "tx-1");

    // Check duplicate by folder fingerprint
    let dup_by_fp = db.check_duplicate("PO-OTHER", "fp_test_123456789", "sha_other").unwrap();
    assert!(dup_by_fp.is_some());

    // Check fresh PO
    let fresh = db.check_duplicate("PO-FRESH-999", "fp_fresh", "sha_fresh").unwrap();
    assert!(fresh.is_none());
}

#[test]
fn test_ax2012_tahoma_gid_repair_and_qtc_filter() {
    // Broken AX 2012 Tahoma GID output observed on real PO-26004156.pdf
    let garbled = "หҖาкหѫҖนสҕวนлѼาдัด พศินสѫе";
    let repaired = ThaiNormalizer::normalize_unicode(garbled);
    assert_eq!(repaired, "ห้างหุ้นส่วนจำกัด พศินสุข");

    // GDI split Sara Am
    let gdi = "ห้างหุ้นส่วนจ ากัด พศินสุข";
    assert_eq!(ThaiNormalizer::normalize_unicode(gdi), "ห้างหุ้นส่วนจำกัด พศินสุข");

    // Self-company QTC Energy must always be ignored
    assert!(ThaiNormalizer::is_ignored_self_company("QTC ENERGY PUBLIC COMPANY LIMITED"));
    assert!(ThaiNormalizer::is_ignored_self_company("บริษัท คิวทีซี เอนเนอร์ยี่ จำกัด (มหาชน)"));
    assert!(!ThaiNormalizer::is_ignored_self_company("ห้างหุ้นส่วนจำกัด พศินสุข"));
}

#[test]
fn test_thai_first_candidates_and_cross_script_matching() {
    let directory = vec![CompanyCacheEntry {
        id: "sheet_row_1".to_string(),
        company_name: "PASINSOOK LIMITED PARTNERSHIP".to_string(),
        alternative_name: None,
        email: "procurementqtc@gmail.com".to_string(),
        active: true,
        tax_id: None,
        notes: None,
        vendor_group: Some("DV".to_string()),
        synced_at: "2026-11-16T00:00:00Z".to_string(),
    }];

    // Phonetic skeleton must unify Thai and English spellings of Pasinsook
    assert_eq!(
        ThaiNormalizer::phonetic_skeleton("ห้างหุ้นส่วนจำกัด พศินสุข"),
        ThaiNormalizer::phonetic_skeleton("PASINSOOK LIMITED PARTNERSHIP")
    );

    let candidates = vec![
        app_lib::ocr::SupplierCandidate {
            name: "QTC ENERGY PUBLIC COMPANY LIMITED".to_string(),
            confidence: 99.0,
            language: "en".to_string(),
            line_index: Some(0),
            source: Some("regex_en".to_string()),
        },
        app_lib::ocr::SupplierCandidate {
            name: "ห้างหุ้นส่วนจำกัด พศินสุข".to_string(),
            confidence: 100.0,
            language: "th".to_string(),
            line_index: Some(9),
            source: Some("spatial_label".to_string()),
        },
        app_lib::ocr::SupplierCandidate {
            name: "PASINSOOK LIMITED PARTNERSHIP".to_string(),
            confidence: 93.0,
            language: "en".to_string(),
            line_index: Some(10),
            source: Some("regex_en".to_string()),
        },
    ];

    let res = CompanyMatcher::match_candidates(&candidates, &directory, &[], 98.0, 90.0, 75.0);
    // Display/query preserves Thai name first
    assert_eq!(res.query, "ห้างหุ้นส่วนจำกัด พศินสุข");
    assert_eq!(res.matched_company.as_ref().unwrap().email, "procurementqtc@gmail.com");
    assert!(res.confidence >= 90.0);
    assert!(res.category == "verified" || res.category == "high");
}

#[test]
fn test_headerless_one_row_sheet_parsing() {
    let matrix = vec![vec![
        "PASINSOOK LIMITED PARTNERSHIP".to_string(),
        "procurementqtc@gmail.com".to_string(),
    ]];
    let parsed = app_lib::google::sheets::SheetsClient::parse_matrix(matrix).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].company_name, "PASINSOOK LIMITED PARTNERSHIP");
    assert_eq!(parsed[0].email, "procurementqtc@gmail.com");
    assert!(parsed[0].alternative_name.is_none());
}

#[test]
fn test_self_learning_memory_and_ngram_matching() {
    let tmp = tempdir().unwrap();
    let db_path = tmp.path().join("learning_test.db");
    let db = Database::new(&db_path).unwrap();

    // 1. Character 3-gram Dice similarity handles OCR typos robustly while separating unrelated strings
    let typo_sim = CompanyMatcher::char_ngram_similarity("สยามซัพพลายเอบีซี", "สยามซัพพลายเอซีซี", 3);
    assert!(typo_sim >= 70.0, "Expected high 3-gram similarity for minor typo, got {}", typo_sim);
    let diff_sim = CompanyMatcher::char_ngram_similarity("สยามซัพพลาย", "กสิกรไทย", 3);
    assert!(diff_sim < 20.0, "Unrelated names should score low, got {}", diff_sim);

    // 2. Simulate a job where OCR wrongly guessed a bank line before manual approval
    let job = Job {
        id: "job-learn-1".to_string(),
        po_folder_name: "PO-26009999".to_string(),
        source_path: "C:\\PO-AutoFlow\\Review\\PO-26009999".to_string(),
        status: "needs_review".to_string(),
        stage_message: "Needs review".to_string(),
        po_number: Some("PO-26009999".to_string()),
        detected_company_raw: Some("ธนาคารกสิกรไทย จำกัด".to_string()),
        matched_company_name: None,
        matched_email: None,
        match_confidence: Some(0.0),
        match_category: Some("no_match".to_string()),
        archive_path: None,
        archive_sha256: None,
        archive_size_bytes: None,
        drive_file_id: None,
        drive_web_link: None,
        email_transaction_id: None,
        retry_count: 0,
        error_details: None,
        created_at: "2026-11-16T00:00:00Z".to_string(),
        updated_at: "2026-11-16T00:00:00Z".to_string(),
        completed_at: None,
    };
    db.insert_job(&job).unwrap();

    let ocr_rec = OcrResultRecord {
        id: "ocr-learn-1".to_string(),
        job_id: job.id.clone(),
        file_path: "PO-Invoice.pdf".to_string(),
        page_number: 1,
        raw_text: "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด Tax ID 0105559008899".to_string(),
        normalized_text: "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด Tax ID 0105559008899".to_string(),
        confidence: 96.0,
        engine: "native_pdf".to_string(),
        bounding_boxes_json: serde_json::json!([
            {
                "box": [[40.0, 120.0], [320.0, 120.0], [320.0, 140.0], [40.0, 140.0]],
                "text": "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด",
                "confidence": 1.0,
                "type": "native"
            },
            {
                "box": [[40.0, 800.0], [320.0, 800.0], [320.0, 820.0], [40.0, 820.0]],
                "text": "Footer",
                "confidence": 1.0,
                "type": "native"
            }
        ])
        .to_string(),
        detected_entities_json: serde_json::json!({
            "po_numbers": ["PO-26009999"],
            "tax_ids": ["0105559008899"],
            "emails": ["sales@apex-supply.co.th"],
            "supplier_candidates": [
                {
                    "name": "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด",
                    "confidence": 96.0,
                    "language": "th",
                    "line_index": 2,
                    "source": "regex_th"
                }
            ],
            "primary_supplier": "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด",
            "primary_confidence": 96.0,
            "primary_supplier_th": "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด",
            "primary_supplier_en": "APEX SUPPLY CO., LTD."
        })
        .to_string(),
        created_at: "2026-11-16T00:00:00Z".to_string(),
    };
    db.record_ocr_result(&ocr_rec).unwrap();

    // Approve job -> triggers self-learning
    let learned = db
        .learn_from_approved_job(&job, "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด", "sales@apex-supply.co.th")
        .unwrap();
    assert!(learned >= 4, "Expected at least 4 signals learned, got {}", learned);

    let directory = db.get_companies_cache().unwrap();
    let aliases = db.get_company_aliases().unwrap();
    let memories = db.get_learning_memories().unwrap();
    let stats = db.get_learning_stats().unwrap();

    assert_eq!(directory.len(), 1);
    assert_eq!(directory[0].company_name, "บริษัท เอเพ็กซ์ ซัพพลาย จำกัด");
    assert_eq!(directory[0].email, "sales@apex-supply.co.th");
    assert_eq!(directory[0].tax_id.as_deref(), Some("0105559008899"));
    assert_eq!(stats.learned_tax_ids, 1);
    assert_eq!(stats.learned_email_domains, 1);
    assert_eq!(stats.negative_phrases_count, 1);
    assert!(stats.learned_zones_count >= 1);

    // 3a. Blacklisted false positive alone must now be suppressed (no_match)
    let neg_only = vec![app_lib::ocr::SupplierCandidate {
        name: "ธนาคารกสิกรไทย จำกัด".to_string(),
        confidence: 95.0,
        language: "th".to_string(),
        line_index: Some(1),
        source: Some("regex_th".to_string()),
    }];
    let res_neg = CompanyMatcher::match_candidates_with_memory(
        &neg_only,
        &[],
        &[],
        &directory,
        &aliases,
        &memories,
        98.0,
        90.0,
        75.0,
    );
    assert_eq!(res_neg.category, "no_match");
    assert!(res_neg.matched_company.is_none());

    // 3b. Subsequent PO with only the 13-digit Tax ID matches at 99.5% verified
    let res_tax = CompanyMatcher::match_candidates_with_memory(
        &neg_only,
        &["0105559008899".to_string()],
        &[],
        &directory,
        &aliases,
        &memories,
        98.0,
        90.0,
        75.0,
    );
    assert_eq!(res_tax.category, "verified");
    assert!(res_tax.confidence >= 99.5);
    assert_eq!(res_tax.matched_by, "learned_tax_id");
    assert_eq!(res_tax.matched_company.unwrap().email, "sales@apex-supply.co.th");

    // 3c. Subsequent PO with noisy OCR spacing/character variant matches at verified level
    let noisy_cand = vec![app_lib::ocr::SupplierCandidate {
        name: "บริษัท เอเพ็กช์ ซัพพลาย จำกัด".to_string(),
        confidence: 88.0,
        language: "th".to_string(),
        line_index: Some(2),
        source: Some("ocr".to_string()),
    }];
    let res_noisy = CompanyMatcher::match_candidates_with_memory(
        &noisy_cand,
        &[],
        &["billing@apex-supply.co.th".to_string()],
        &directory,
        &aliases,
        &memories,
        98.0,
        90.0,
        75.0,
    );
    assert!(res_noisy.confidence >= 98.0, "Expected verified confidence, got {}", res_noisy.confidence);
    assert_eq!(res_noisy.category, "verified");
}

#[test]
fn test_bilingual_and_proofing_sheet_columns() {
    let matrix = vec![
        vec![
            "Thai Name".to_string(),
            "English Name".to_string(),
            "Email".to_string(),
            "Proofing".to_string(),
        ],
        vec![
            "บริษัท สยาม ซัพพลาย จำกัด".to_string(),
            "SIAM SUPPLY CO., LTD.".to_string(),
            "sales@siamsupply.co.th".to_string(),
            "Verified AX2012".to_string(),
        ],
        vec![
            "".to_string(),
            "ENGLISH ONLY CORP.".to_string(),
            "ap@englishonly.com".to_string(),
            "EN only row".to_string(),
        ],
        vec![
            "บริษัท ไทยอย่างเดียว จำกัด".to_string(),
            "".to_string(),
            "th@only.co.th".to_string(),
            "".to_string(),
        ],
    ];

    let entries = app_lib::google::sheets::SheetsClient::parse_matrix(matrix).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].company_name, "บริษัท สยาม ซัพพลาย จำกัด");
    assert_eq!(entries[0].alternative_name.as_deref(), Some("SIAM SUPPLY CO., LTD."));
    assert_eq!(entries[0].notes.as_deref(), Some("Verified AX2012"));

    // Row with empty Thai cell still loads cleanly from English Name
    assert_eq!(entries[1].company_name, "ENGLISH ONLY CORP.");
    assert_eq!(entries[1].alternative_name, None);
    assert_eq!(entries[1].notes.as_deref(), Some("EN only row"));

    // Row with empty English cell still loads cleanly from Thai Name
    assert_eq!(entries[2].company_name, "บริษัท ไทยอย่างเดียว จำกัด");
    assert_eq!(entries[2].alternative_name, None);

    // Headerless 3-column sheet: Thai | English | Email
    let headerless = vec![vec![
        "บริษัท ทดสอบ จำกัด".to_string(),
        "TEST CO., LTD.".to_string(),
        "test@example.com".to_string(),
    ]];
    let entries_hl = app_lib::google::sheets::SheetsClient::parse_matrix(headerless).unwrap();
    assert_eq!(entries_hl.len(), 1);
    assert_eq!(entries_hl[0].company_name, "บริษัท ทดสอบ จำกัด");
    assert_eq!(entries_hl[0].alternative_name.as_deref(), Some("TEST CO., LTD."));
    assert_eq!(entries_hl[0].email, "test@example.com");
}

#[test]
fn test_digital_po_document_priority() {
    let tmp = tempdir().unwrap();
    let po_dir = tmp.path().join("PO-26001212");
    std::fs::create_dir_all(&po_dir).unwrap();

    // Supporting files alphabetically before "PO-..." must still sort after matching PO PDF
    File::create(po_dir.join("01_invoice_scan.pdf")).unwrap().write_all(b"%PDF-1.4").unwrap();
    File::create(po_dir.join("quotation.pdf")).unwrap().write_all(b"%PDF-1.4").unwrap();
    File::create(po_dir.join("PO-26001212.pdf")).unwrap().write_all(b"%PDF-1.4").unwrap();

    let docs = app_lib::document::DocumentScanner::scan_po_folder(&po_dir).unwrap();
    assert_eq!(docs.len(), 3);
    assert_eq!(docs[0].relative_path, "PO-26001212.pdf");
}

#[test]
fn test_dv_ov_multi_tab_and_vendor_classification() {
    let tabs = app_lib::google::sheets::resolve_sheet_tabs("DV", "OV");
    assert_eq!(tabs, vec!["DV".to_string(), "OV".to_string()]);

    let combined = app_lib::google::sheets::resolve_sheet_tabs("DV, OV", "");
    assert_eq!(combined, vec!["DV".to_string(), "OV".to_string()]);

    assert_eq!(app_lib::google::sheets::vendor_group_label("DV", "OV"), "DV");
    assert_eq!(app_lib::google::sheets::vendor_group_label("OV", "OV"), "OV");
    assert_eq!(
        app_lib::google::sheets::vendor_group_label("Oversea Vendors", ""),
        "OV"
    );
    assert_eq!(
        app_lib::google::sheets::vendor_group_label("Domestic Vendors", ""),
        "DV"
    );

    // Domestic classifications
    assert!(!app_lib::google::sheets::is_overseas_vendor(
        "บริษัท สยาม ซัพพลาย จำกัด",
        "",
        "sales@siam.com",
        ""
    ));
    assert!(!app_lib::google::sheets::is_overseas_vendor(
        "SIAM SUPPLY CO., LTD.",
        "",
        "orders@siamsupply.co.th",
        ""
    ));
    assert!(!app_lib::google::sheets::is_overseas_vendor(
        "PASINSOOK LIMITED PARTNERSHIP",
        "",
        "sales@vendor.com",
        "0103554009876"
    ));

    // Overseas classifications
    assert!(app_lib::google::sheets::is_overseas_vendor(
        "SIEMENS ENERGY GMBH",
        "",
        "orders@siemens-energy.de",
        ""
    ));
    assert!(app_lib::google::sheets::is_overseas_vendor(
        "ACME ASIA PACIFIC PTE. LTD.",
        "",
        "ap@acme.sg",
        ""
    ));

    // Multi-email list containing a .co.th address + gmail fallback remains DV
    assert!(!app_lib::google::sheets::is_overseas_vendor(
        "SIAM SUPPLY CO., LTD.",
        "",
        "sales@siamsupply.co.th, backup@gmail.com",
        ""
    ));
}




