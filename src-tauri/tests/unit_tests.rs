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
        matched_department: None,
        department_cc_emails: None,
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

#[test]
fn test_exact_gmail_and_shared_email_combo_matching() {
    let dir = vec![
        CompanyCacheEntry {
            id: "row_1".to_string(),
            company_name: "บริษัท อัลฟ่า เทค จำกัด".to_string(),
            alternative_name: Some("ALPHA TECH PTE. LTD.".to_string()),
            email: "billing@alphasupply.gmail.com, owner@gmail.com".to_string(),
            active: true,
            tax_id: None,
            notes: Some("Alpha Group Branch 1".to_string()),
            vendor_group: Some("DV".to_string()),
            synced_at: "2026-11-17T00:00:00Z".to_string(),
        },
        CompanyCacheEntry {
            id: "row_2".to_string(),
            company_name: "บริษัท เบต้า เซอร์วิส จำกัด".to_string(),
            alternative_name: Some("BETA SERVICE CO., LTD.".to_string()),
            email: "owner@gmail.com".to_string(),
            active: true,
            tax_id: None,
            notes: None,
            vendor_group: Some("DV".to_string()),
            synced_at: "2026-11-17T00:00:00Z".to_string(),
        },
        CompanyCacheEntry {
            id: "row_3".to_string(),
            company_name: "บริษัท แกรมม่า ซัพพลาย จำกัด".to_string(),
            alternative_name: None,
            email: "unique.vendor99@gmail.com".to_string(),
            active: true,
            tax_id: None,
            notes: None,
            vendor_group: Some("DV".to_string()),
            synced_at: "2026-11-17T00:00:00Z".to_string(),
        },
    ];

    // 1. Unique exact @gmail.com email matches cleanly even when OCR name is unrecognizable
    let only_gmail = CompanyMatcher::match_candidates_with_memory(
        &[app_lib::ocr::SupplierCandidate {
            name: "UNRELATED HEADER TEXT".to_string(),
            confidence: 80.0,
            language: "en".to_string(),
            line_index: Some(0),
            source: Some("regex".to_string()),
        }],
        &[],
        &["unique.vendor99@gmail.com".to_string()],
        &dir,
        &[],
        &[],
        98.0,
        90.0,
        75.0,
    );
    assert_eq!(only_gmail.matched_by, "exact_email");
    assert_eq!(only_gmail.category, "verified");
    assert!(!only_gmail.is_ambiguous);
    assert_eq!(
        only_gmail.matched_company.unwrap().company_name,
        "บริษัท แกรมม่า ซัพพลาย จำกัด"
    );

    // 2. Shared @gmail.com across two companies: weak/generic name + exact email resolves right combo
    let shared_with_name = CompanyMatcher::match_candidates_with_memory(
        &[app_lib::ocr::SupplierCandidate {
            name: "BETA SERVICE".to_string(),
            confidence: 90.0,
            language: "en".to_string(),
            line_index: Some(1),
            source: Some("regex".to_string()),
        }],
        &[],
        &["owner@gmail.com".to_string()],
        &dir,
        &[],
        &[],
        98.0,
        90.0,
        75.0,
    );
    assert!(!shared_with_name.is_ambiguous);
    assert_eq!(
        shared_with_name.matched_company.unwrap().company_name,
        "บริษัท เบต้า เซอร์วิส จำกัด"
    );

    // 3. Shared @gmail.com with zero matching name stays safely in review as ambiguous
    let shared_no_name = CompanyMatcher::match_candidates_with_memory(
        &[],
        &[],
        &["owner@gmail.com".to_string()],
        &dir,
        &[],
        &[],
        98.0,
        90.0,
        75.0,
    );
    assert_eq!(shared_no_name.category, "review");
    assert!(shared_no_name.is_ambiguous);
    assert_eq!(shared_no_name.matched_by, "ambiguous_shared_email");
}

#[test]
fn test_branch_international_suffix_and_alias_on_alt_name() {
    assert_eq!(
        ThaiNormalizer::clean_company_name("บริษัท เอบีซี จำกัด (สาขาที่ 00001)"),
        "เอบีซี"
    );
    assert_eq!(
        ThaiNormalizer::clean_company_name("SIEMENS ENERGY GMBH Branch 2"),
        "siemens energy"
    );
    assert_eq!(
        ThaiNormalizer::clean_company_name("ACME ASIA PTE. LTD."),
        "acme asia"
    );
    // Boundary safety: words ending in "lab" or "corp" without separator must stay intact
    assert_eq!(ThaiNormalizer::clean_company_name("BIOLAB"), "biolab");

    let dir = vec![CompanyCacheEntry {
        id: "ov_1".to_string(),
        company_name: "เอซีมี เอเชีย".to_string(),
        alternative_name: Some("ACME ASIA PTE. LTD.".to_string()),
        email: "ap@acme.sg".to_string(),
        active: true,
        tax_id: None,
        notes: Some("ACME SINGAPORE".to_string()),
        vendor_group: Some("OV".to_string()),
        synced_at: "2026-11-17T00:00:00Z".to_string(),
    }];

    // Alias pointing to alternative_name still resolves canonical Sheet entry
    let aliases = vec![CompanyAlias {
        id: "al_1".to_string(),
        alias: "ACME ASIA SG".to_string(),
        canonical_company_name: "ACME ASIA PTE. LTD.".to_string(),
        created_by: "user".to_string(),
        created_at: "2026-11-17T00:00:00Z".to_string(),
    }];
    let alias_hit = CompanyMatcher::match_company("ACME ASIA SG", &dir, &aliases, 98.0, 90.0, 75.0);
    assert_eq!(alias_hit.matched_by, "alias");
    assert_eq!(alias_hit.matched_company.unwrap().id, "ov_1");

    // Usable proofing note matches cleanly
    let note_hit = CompanyMatcher::match_company("ACME SINGAPORE", &dir, &[], 98.0, 90.0, 75.0);
    assert_eq!(note_hit.category, "verified");
    assert_eq!(note_hit.matched_by, "notes");
}

#[test]
fn test_safe_move_folder_archives_existing_dest_and_blocks_temp_files() {
    let tmp = tempdir().unwrap();
    let incoming = tmp.path().join("Incoming");
    let sent = tmp.path().join("Sent");
    std::fs::create_dir_all(incoming.join("PO-999")).unwrap();
    std::fs::create_dir_all(sent.join("PO-999")).unwrap();

    // Old Sent copy must never be lost if a new PO-999 is moved in
    std::fs::write(sent.join("PO-999").join("old_sent.txt"), b"original").unwrap();
    let new_file = incoming.join("PO-999").join("new_po.pdf");
    std::fs::write(&new_file, b"new_pdf").unwrap();

    // Temp/browser lock file inside folder must block stability readiness
    let temp_part = incoming.join("PO-999").join("invoice.pdf.crdownload");
    std::fs::write(&temp_part, b"partial").unwrap();
    assert!(!app_lib::watcher::stability::FileStabilityChecker::can_open_all_files(
        &incoming.join("PO-999")
    ));
    std::fs::remove_file(&temp_part).unwrap();
    assert!(app_lib::watcher::stability::FileStabilityChecker::can_open_all_files(
        &incoming.join("PO-999")
    ));

    let moved_dest = app_lib::pipeline::move_folder_to_dir(
        &incoming.join("PO-999"),
        &sent.to_string_lossy(),
    )
    .unwrap();
    assert!(moved_dest.join("new_po.pdf").exists());
    assert!(!incoming.join("PO-999").exists());

    // Verify previous Sent/PO-999 was archived safely as PO-999__prev_*
    let archived_exists = std::fs::read_dir(&sent)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("PO-999__prev_") && e.path().join("old_sent.txt").exists()
        });
    assert!(archived_exists);

    // Non-existent source returns Err instead of Ok
    assert!(
        app_lib::pipeline::move_folder_to_dir(&incoming.join("MISSING-PO"), &sent.to_string_lossy())
            .is_err()
    );
}

#[test]
fn test_cc_email_normalization() {
    assert_eq!(EmailDeliveryClient::normalize_cc_list("").unwrap(), "");
    assert_eq!(EmailDeliveryClient::normalize_cc_list("   , ;  ").unwrap(), "");
    assert_eq!(
        EmailDeliveryClient::normalize_cc_list(
            "yuwanit.n@qtc-energy.com; manager@gmail.com, yuwanit.n@qtc-energy.com"
        )
        .unwrap(),
        "yuwanit.n@qtc-energy.com, manager@gmail.com"
    );
    assert!(EmailDeliveryClient::normalize_cc_list("valid@gmail.com, not-an-email").is_err());

    assert_eq!(
        EmailDeliveryClient::merge_cc_lists(&[
            "yuwanit.n@qtc-energy.com",
            "sales@qtc-energy.com, YUWANIT.N@QTC-ENERGY.COM",
            "supervisor@qtc-energy.com"
        ]),
        "yuwanit.n@qtc-energy.com, sales@qtc-energy.com, supervisor@qtc-energy.com"
    );
}

#[test]
fn test_department_cc_sheet_parsing_and_exact_matching() {
    let matrix = vec![
        vec!["No.".to_string(), "แผนก".to_string(), "Email".to_string()],
        vec!["11".to_string(), "ส่วนออกแบบ".to_string(), "design1@qtc-energy.com".to_string()],
        vec![
            "17".to_string(),
            "ส่วนออกแบบ".to_string(),
            "design2@qtc-energy.com, design1@qtc-energy.com".to_string(),
        ],
        vec!["38".to_string(), "ธุรกิจโซล่าร์".to_string(), "solar@qtc-energy.com".to_string()],
        vec![
            "37".to_string(),
            "ส่วนสนับสนุนขายธุรกิจโซล่าร์".to_string(),
            "solarsupport@qtc-energy.com".to_string(),
        ],
        vec![
            "40".to_string(),
            "ฝ่ายขายในประเทศ".to_string(),
            "domsales@qtc-energy.com, manager.dom@qtc-energy.com".to_string(),
        ],
        vec!["42".to_string(), "ฝ่ายขายต่างประเทศ".to_string(), "exportsales@qtc-energy.com".to_string()],
        vec![
            "45".to_string(),
            "ฝ่ายคลังสินค้า และ Logistic".to_string(),
            "wh@qtc-energy.com".to_string(),
        ],
    ];

    let depts = app_lib::google::sheets::SheetsClient::parse_department_matrix(matrix).unwrap();
    // Rows 11 and 17 ('ส่วนออกแบบ') merge cleanly into 1 deduplicated entry
    assert_eq!(depts.len(), 6);
    let design = depts.iter().find(|d| d.department_name == "ส่วนออกแบบ").unwrap();
    assert_eq!(design.emails, "design1@qtc-energy.com, design2@qtc-energy.com");

    // Domestic sales must NEVER confuse with overseas sales
    let (dom_name, dom_cc) =
        CompanyMatcher::match_department_cc(&["ฝ่ายขายในประเทศ".to_string()], &depts);
    assert_eq!(dom_name.as_deref(), Some("ฝ่ายขายในประเทศ"));
    assert_eq!(dom_cc, "domsales@qtc-energy.com, manager.dom@qtc-energy.com");

    // Longer department phrase ('ส่วนสนับสนุนขายธุรกิจโซล่าร์') wins over shorter ('ธุรกิจโซล่าร์')
    let (solar_sup_name, solar_sup_cc) =
        CompanyMatcher::match_department_cc(&["ส่วนสนับสนุนขายธุรกิจโซล่าร์".to_string()], &depts);
    assert_eq!(solar_sup_name.as_deref(), Some("ส่วนสนับสนุนขายธุรกิจโซล่าร์"));
    assert_eq!(solar_sup_cc, "solarsupport@qtc-energy.com");

    // Spacing differences around 'และ' match cleanly
    let (wh_name, wh_cc) =
        CompanyMatcher::match_department_cc(&["ฝ่ายคลังสินค้าและLogistic".to_string()], &depts);
    assert_eq!(wh_name.as_deref(), Some("ฝ่ายคลังสินค้า และ Logistic"));
    assert_eq!(wh_cc, "wh@qtc-energy.com");
}







#[test]
fn test_ai_chat_builtin_presets_and_reply_cleaning() {
    use app_lib::ai_chat::{clean_ai_reply_text, is_localhost_url};
    use app_lib::commands::builtin_vision_presets_summary;
    use std::collections::HashSet;

    let presets = builtin_vision_presets_summary();
    let ids: HashSet<&str> = presets.iter().map(|p| p.0).collect();
    assert_eq!(ids.len(), presets.len(), "Preset IDs must be unique");
    for required in [
        "smolvlm2-500m",
        "smolvlm2-2.2b",
        "lfm3-vl-2b",
        "qwen3-vl-2b",
        "qwen2.5-vl-3b",
        "qwen3-vl-4b",
        "gemma-4-e2b",
        "typhoon-ocr-3b",
    ] {
        assert!(ids.contains(required), "Missing preset: {}", required);
    }

    for (id, name, bytes, model_url, mmproj_url) in &presets {
        assert!(!name.trim().is_empty(), "Empty name for {}", id);
        assert!(*bytes > 400_000_000, "Suspicious size for {}", id);
        assert!(model_url.starts_with("https://huggingface.co/") && model_url.ends_with(".gguf"));
        assert!(mmproj_url.starts_with("https://huggingface.co/") && mmproj_url.ends_with(".gguf"));
    }

    let raw_think = "<think>\nChecking DB PO records carefully...\n</think>\nPO-690123 is currently in needs_review.";
    assert_eq!(
        clean_ai_reply_text(raw_think),
        "PO-690123 is currently in needs_review."
    );

    let unclosed = "Found email: sales@ample.co.th\n<think>unfinished internal note";
    assert_eq!(clean_ai_reply_text(unclosed), "Found email: sales@ample.co.th");

    assert!(is_localhost_url("http://127.0.0.1:11434"));
    assert!(is_localhost_url("http://localhost:8080/v1"));
    assert!(!is_localhost_url("https://api.openai.com/v1"));
}

#[test]
fn test_ai_procurement_grounding_retrieval() {
    use app_lib::ai_chat::gather_procurement_context;

    let tmp = tempdir().unwrap();
    let db = Database::new(tmp.path().join("ai_test.db")).unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    db.sync_companies_cache(&[
        CompanyCacheEntry {
            id: "c1".to_string(),
            company_name: "บริษัท แอมเพิล เทคโนโลยี จำกัด".to_string(),
            alternative_name: Some("AMPLE TECHNOLOGY CO., LTD.".to_string()),
            email: "sales@ample.co.th, billing@ample.co.th".to_string(),
            active: true,
            tax_id: Some("0105551234567".to_string()),
            notes: Some("VIP electrical vendor".to_string()),
            vendor_group: Some("DV".to_string()),
            synced_at: now.clone(),
        },
        CompanyCacheEntry {
            id: "c2".to_string(),
            company_name: "Schneider Electric (Thailand) Ltd.".to_string(),
            alternative_name: None,
            email: "orders@se.example.com".to_string(),
            active: true,
            tax_id: Some("0105544001122".to_string()),
            notes: None,
            vendor_group: Some("DV".to_string()),
            synced_at: now.clone(),
        },
    ])
    .unwrap();

    db.sync_department_cc_cache(&[
        DepartmentCcEntry {
            id: "40".to_string(),
            department_name: "ฝ่ายขายในประเทศ".to_string(),
            emails: "domsales@qtc-energy.com, lead@qtc-energy.com".to_string(),
            synced_at: now.clone(),
        },
        DepartmentCcEntry {
            id: "22".to_string(),
            department_name: "แผนก MIS".to_string(),
            emails: "mis@qtc-energy.com".to_string(),
            synced_at: now.clone(),
        },
    ])
    .unwrap();

    db.insert_job(&Job {
        id: "job-690123".to_string(),
        po_folder_name: "PO-690123_Ample".to_string(),
        source_path: "C:\\PO-AutoFlow\\Review\\PO-690123_Ample".to_string(),
        status: "needs_review".to_string(),
        stage_message: "Waiting manual confirmation (78.5%)".to_string(),
        po_number: Some("690123".to_string()),
        detected_company_raw: Some("AMPLE TECH CO LTD".to_string()),
        matched_company_name: Some("บริษัท แอมเพิล เทคโนโลยี จำกัด".to_string()),
        matched_email: Some("sales@ample.co.th, billing@ample.co.th".to_string()),
        matched_department: Some("ฝ่ายขายในประเทศ".to_string()),
        department_cc_emails: Some("domsales@qtc-energy.com, lead@qtc-energy.com".to_string()),
        match_confidence: Some(78.5),
        match_category: Some("review".to_string()),
        archive_path: None,
        archive_sha256: None,
        archive_size_bytes: None,
        drive_file_id: None,
        drive_web_link: None,
        email_transaction_id: None,
        retry_count: 0,
        error_details: Some("Confidence 78.5% below auto-send threshold 90%".to_string()),
        created_at: now.clone(),
        updated_at: now.clone(),
        completed_at: None,
    })
    .unwrap();

    db.record_ocr_result(&OcrResultRecord {
        id: "ocr-1".to_string(),
        job_id: "job-690123".to_string(),
        file_path: "PO690123.pdf".to_string(),
        page_number: 1,
        raw_text: "Purchase Order 690123 Grand Total 42,800.00 THB".to_string(),
        normalized_text: "Purchase Order 690123 Grand Total 42,800.00 THB".to_string(),
        confidence: 96.0,
        engine: "Digital PDF".to_string(),
        bounding_boxes_json: "[]".to_string(),
        detected_entities_json: "{}".to_string(),
        created_at: now.clone(),
    })
    .unwrap();

    // Query by PO number brings in the job AND its OCR document text
    let by_po = gather_procurement_context(&db, "ทำไม PO 690123 ค้างอยู่ และยอดรวมเท่าไหร่?", None);
    assert_eq!(by_po.matched_jobs.len(), 1);
    assert_eq!(by_po.matched_jobs[0].id, "job-690123");
    assert!(by_po.system_grounding_prompt.contains("42,800.00 THB"));
    assert!(by_po.system_grounding_prompt.contains("Confidence 78.5% below auto-send threshold 90%"));

    // Query by Thai supplier & department pulls both Supplier & Dept CC cards accurately
    let by_thai = gather_procurement_context(&db, "ขออีเมล แอมเพิล กับ CC ฝ่ายขายในประเทศ", None);
    assert!(by_thai
        .matched_companies
        .iter()
        .any(|c| c.email.contains("sales@ample.co.th")));
    assert!(by_thai
        .matched_departments
        .iter()
        .any(|d| d.emails.contains("domsales@qtc-energy.com")));

    // Query by review status surfaces needs_review jobs cleanly
    let by_review = gather_procurement_context(&db, "Find POs needing review", None);
    assert!(by_review.matched_jobs.iter().any(|j| j.id == "job-690123"));
}

#[test]
fn test_delete_job_and_ui_state_persistence() {
    use app_lib::commands::is_safe_managed_dir;

    let tmp = tempdir().unwrap();
    let root = tmp.path().join("PO-AutoFlow");
    let incoming = root.join("Incoming");
    let review = root.join("Review");
    let outside = tmp.path().join("OutsideImportant");
    std::fs::create_dir_all(incoming.join("PO-DEL-001")).unwrap();
    std::fs::create_dir_all(&review).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    let mut settings = AppSettings::default();
    settings.root_dir = root.to_string_lossy().to_string();
    settings.incoming_dir = incoming.to_string_lossy().to_string();
    settings.processing_dir = root.join("Processing").to_string_lossy().to_string();
    settings.review_dir = review.to_string_lossy().to_string();
    settings.failed_dir = root.join("Failed").to_string_lossy().to_string();
    settings.sent_dir = root.join("Sent").to_string_lossy().to_string();
    settings.temp_dir = root.join("Temp").to_string_lossy().to_string();
    std::fs::create_dir_all(&settings.processing_dir).unwrap();
    std::fs::create_dir_all(&settings.failed_dir).unwrap();
    std::fs::create_dir_all(&settings.sent_dir).unwrap();
    std::fs::create_dir_all(&settings.temp_dir).unwrap();

    // Path safety checks: only direct child subfolders under workflow dirs are removable
    assert!(is_safe_managed_dir(&incoming.join("PO-DEL-001"), &settings));
    assert!(!is_safe_managed_dir(&incoming, &settings));
    assert!(!is_safe_managed_dir(&root, &settings));
    assert!(!is_safe_managed_dir(&outside, &settings));

    let db = Database::new(tmp.path().join("queue_state.db")).unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // 1. UI State persistence
    db.set_ui_state("app.currentTab", "\"assistant\"").unwrap();
    db.set_ui_state("inspector.pageByJob", "{\"job-1\":2}").unwrap();
    db.set_ui_state("app.currentTab", "\"ocr-inspector\"").unwrap();
    let ui_map = db.get_all_ui_state().unwrap();
    assert_eq!(ui_map.get("app.currentTab").map(String::as_str), Some("\"ocr-inspector\""));
    assert_eq!(ui_map.get("inspector.pageByJob").map(String::as_str), Some("{\"job-1\":2}"));

    // 2. Deleting a job cleans cascading tables & events while preserving historical transactions
    db.insert_job(&Job {
        id: "job-del-1".to_string(),
        po_folder_name: "PO-DEL-001".to_string(),
        source_path: incoming.join("PO-DEL-001").to_string_lossy().to_string(),
        status: "needs_review".to_string(),
        stage_message: "Needs review".to_string(),
        po_number: Some("PO-DEL-001".to_string()),
        detected_company_raw: Some("Demo Vendor".to_string()),
        matched_company_name: None,
        matched_email: None,
        matched_department: None,
        department_cc_emails: None,
        match_confidence: Some(60.0),
        match_category: Some("review".to_string()),
        archive_path: None,
        archive_sha256: None,
        archive_size_bytes: None,
        drive_file_id: None,
        drive_web_link: None,
        email_transaction_id: None,
        retry_count: 0,
        error_details: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        completed_at: None,
    })
    .unwrap();

    db.record_ocr_result(&OcrResultRecord {
        id: "ocr-del-1".to_string(),
        job_id: "job-del-1".to_string(),
        file_path: "PO.pdf".to_string(),
        page_number: 1,
        raw_text: "test".to_string(),
        normalized_text: "test".to_string(),
        confidence: 95.0,
        engine: "native_pdf".to_string(),
        bounding_boxes_json: "[]".to_string(),
        detected_entities_json: "{}".to_string(),
        created_at: now.clone(),
    })
    .unwrap();

    db.add_event(Some("job-del-1"), "info", "Queued for test").unwrap();
    db.record_transaction(&PoTransaction {
        id: "tx-keep-1".to_string(),
        job_id: "job-del-1".to_string(),
        po_number: "PO-DEL-001".to_string(),
        folder_fingerprint: "fp-del-1".to_string(),
        archive_sha256: "sha-del-1".to_string(),
        company_name: "Demo Vendor".to_string(),
        recipient_email: "vendor@example.com".to_string(),
        status: "sent".to_string(),
        gas_execution_id: None,
        error_message: None,
        sent_at: now,
    })
    .unwrap();

    let deleted = db.delete_job("job-del-1").unwrap();
    assert!(deleted.is_some());
    assert!(db.get_job("job-del-1").unwrap().is_none());
    assert!(db.get_ocr_results_for_job("job-del-1").unwrap().is_empty());
    assert!(db.get_recent_events(10).unwrap().is_empty());
    // Duplicate-send ledger record stays intact!
    assert_eq!(db.list_transactions(10, 0).unwrap().len(), 1);
    assert!(db.delete_job("non-existent-id").unwrap().is_none());
}

#[test]
fn test_ai_harness_greeting_and_anti_substring_noise_guards() {
    use app_lib::ai_chat::{gather_procurement_context_with_history, ChatHistoryMessage};

    let tmp = tempdir().unwrap();
    let db = Database::new(tmp.path().join("harness_noise.db")).unwrap();
    let now = chrono::Utc::now().to_rfc3339();

    // Seed companies whose names contain "hi" inside substrings + one malformed empty row!
    db.sync_companies_cache(&[
        CompanyCacheEntry {
            id: "h1".to_string(),
            company_name: "Hitachi Energy Hefei Transformer Co.,Ltd".to_string(),
            alternative_name: None,
            email: "wenbin@example.com".to_string(),
            active: true,
            tax_id: None,
            notes: None,
            vendor_group: Some("OV".to_string()),
            synced_at: now.clone(),
        },
        CompanyCacheEntry {
            id: "h2".to_string(),
            company_name: "Toshiba Industrial Products".to_string(),
            alternative_name: None,
            email: "tosh@example.com".to_string(),
            active: true,
            tax_id: None,
            notes: None,
            vendor_group: Some("OV".to_string()),
            synced_at: now.clone(),
        },
        CompanyCacheEntry {
            id: "blank-row".to_string(),
            company_name: "".to_string(),
            alternative_name: None,
            email: "".to_string(),
            active: true,
            tax_id: None,
            notes: None,
            vendor_group: Some("DV".to_string()),
            synced_at: now.clone(),
        },
    ])
    .unwrap();

    db.insert_job(&Job {
        id: "job-partner".to_string(),
        po_folder_name: "PO-26004156".to_string(),
        source_path: "C:\\PO-AutoFlow\\Sent\\PO-26004156".to_string(),
        status: "completed".to_string(),
        stage_message: "Delivered cleanly".to_string(),
        po_number: Some("PO-26004156".to_string()),
        detected_company_raw: Some("PASINSOOK LIMITED PARTNERSHIP".to_string()),
        matched_company_name: Some("PASINSOOK LIMITED PARTNERSHIP".to_string()),
        matched_email: Some("pasinsook@example.com".to_string()),
        matched_department: None,
        department_cc_emails: None,
        match_confidence: Some(99.0),
        match_category: Some("verified".to_string()),
        archive_path: None,
        archive_sha256: None,
        archive_size_bytes: None,
        drive_file_id: None,
        drive_web_link: None,
        email_transaction_id: None,
        retry_count: 0,
        error_details: None,
        created_at: now.clone(),
        updated_at: now.clone(),
        completed_at: Some(now.clone()),
    })
    .unwrap();

    // 1. Greeting "hi" MUST NEVER match "Hitachi", "Toshiba", blank rows, or "PARTNERSHIP"
    let hi_res = gather_procurement_context_with_history(&db, "hi", &[], None);
    assert!(hi_res.matched_jobs.is_empty(), "hi must not match PO jobs: {:?}", hi_res.matched_jobs);
    assert!(hi_res.matched_companies.is_empty(), "hi must not match Hitachi/Toshiba/blank: {:?}", hi_res.matched_companies);
    assert!(hi_res.matched_departments.is_empty());

    // Thai greeting too!
    let th_hi = gather_procurement_context_with_history(&db, "สวัสดีครับ", &[], None);
    assert!(th_hi.matched_jobs.is_empty());
    assert!(th_hi.matched_companies.is_empty());

    // 2. Real supplier lookup "Hitachi" matches Hitachi accurately and ignores blank row
    let hitachi_res = gather_procurement_context_with_history(&db, "find Hitachi email", &[], None);
    assert_eq!(hitachi_res.matched_companies.len(), 1);
    assert!(hitachi_res.matched_companies[0].company_name.contains("Hitachi"));

    // 3. Follow-up question in history carries PO-26004156 context automatically
    let history = vec![ChatHistoryMessage {
        role: "user".to_string(),
        content: "find PO-26004156".to_string(),
    }];
    let followup = gather_procurement_context_with_history(&db, "what email was that sent to?", &history, None);
    assert_eq!(followup.matched_jobs.len(), 1);
    assert_eq!(followup.matched_jobs[0].po_number.as_deref(), Some("PO-26004156"));
}
