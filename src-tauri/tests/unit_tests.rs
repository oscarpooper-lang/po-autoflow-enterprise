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


