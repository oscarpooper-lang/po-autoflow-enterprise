use app_lib::archive::ArchiveManager;
use app_lib::database::models::*;
use app_lib::database::Database;
use app_lib::document::DocumentScanner;
use app_lib::matching::CompanyMatcher;
use app_lib::watcher::stability::FileStabilityChecker;
use std::fs;
use tempfile::tempdir;

#[tokio::test]
async fn test_end_to_end_po_pipeline_workflow() {
    // 1. Setup isolated temporary root environment
    let root_temp = tempdir().expect("Failed to create tempdir");
    let root_path = root_temp.path();

    let incoming_dir = root_path.join("Incoming");
    let processing_dir = root_path.join("Processing");
    let sent_dir = root_path.join("Sent");
    let failed_dir = root_path.join("Failed");
    let review_dir = root_path.join("Review");
    let temp_dir = root_path.join("Temp");
    let db_path = root_path.join("autoflow.db");

    fs::create_dir_all(&incoming_dir).unwrap();
    fs::create_dir_all(&processing_dir).unwrap();
    fs::create_dir_all(&sent_dir).unwrap();
    fs::create_dir_all(&failed_dir).unwrap();
    fs::create_dir_all(&review_dir).unwrap();
    fs::create_dir_all(&temp_dir).unwrap();

    // 2. Initialize Database & Run Migrations
    let db = Database::new(&db_path).expect("Database initialization failed");

    // 3. Populate Company Directory Cache (Simulating Google Sheets Sync)
    let sample_company = CompanyCacheEntry {
        id: "comp_siam_001".to_string(),
        company_name: "บริษัท สยาม ซัพพลาย อินดัสทรี จำกัด".to_string(),
        alternative_name: Some("SIAM SUPPLY INDUSTRY CO., LTD.".to_string()),
        email: "orders@siamsupply.co.th".to_string(),
        active: true,
        tax_id: Some("0105558012345".to_string()),
        notes: Some("Preferred Tier-1 Supplier".to_string()),
        vendor_group: Some("DV".to_string()),
        synced_at: chrono::Utc::now().to_rfc3339(),
    };
    db.sync_companies_cache(&[sample_company.clone()])
        .expect("Failed to insert company");

    db.add_company_alias(
        "SIAM SUPPLY IND",
        &sample_company.company_name,
        "test_suite",
    )
    .expect("Failed to insert alias");

    // 4. Simulate user dropping a PO folder into Incoming
    let po_folder_name = "PO-26002323";
    let po_incoming_path = incoming_dir.join(po_folder_name);
    let po_nested_dir = po_incoming_path.join("Additional-Documents");
    fs::create_dir_all(&po_nested_dir).unwrap();

    // Write sample invoice & documents
    let file1_path = po_incoming_path.join("PO-Invoice.pdf");
    fs::write(&file1_path, b"%PDF-1.4 ... SIAM SUPPLY INDUSTRY CO., LTD. ... PO-26002323 ...").unwrap();

    let file2_path = po_nested_dir.join("Document1.jpg");
    fs::write(&file2_path, b"IMAGE_DATA_SIMULATION_PURCHASE_ORDER_SIAM").unwrap();

    // 5. Test File Stability Checker
    let stability_checker = FileStabilityChecker::new(20, 2, 5);
    let stability_result = stability_checker.wait_for_stability(&po_incoming_path).await;
    assert!(stability_result.is_ok(), "Folder should be detected as stable");
    let snapshot = stability_result.unwrap();
    assert_eq!(snapshot.file_count, 2);

    // 6. Test Recursive Document Discovery
    let discovered_files = DocumentScanner::scan_po_folder(&po_incoming_path).expect("Scan failed");
    assert_eq!(discovered_files.len(), 2, "Discovered files should match nested folder count");

    // 7. Test Company Matching Against Cached Directory
    let directory = db.get_companies_cache().expect("Failed to fetch companies");
    let aliases = db.get_company_aliases().expect("Failed to fetch aliases");

    let match_result = CompanyMatcher::match_company(
        "SIAM SUPPLY INDUSTRY CO., LTD.",
        &directory,
        &aliases,
        98.0,
        90.0,
        75.0,
    );
    assert!(match_result.matched_company.is_some(), "Should find a company match");
    let matched = match_result.matched_company.unwrap();
    assert_eq!(matched.email, "orders@siamsupply.co.th");
    assert!(match_result.confidence >= 90.0, "Confidence should be >= 90%");
    assert_eq!(match_result.category, "verified");

    // 8. Test ZIP Packaging & Integrity
    let output_zip = temp_dir.join(format!("{}.zip", po_folder_name));
    let archive_meta = ArchiveManager::create_po_archive(&po_incoming_path, &output_zip, 25).expect("Archive failed");
    assert!(output_zip.exists(), "ZIP archive must exist");
    assert_eq!(archive_meta.file_count, 2);
    assert!(!archive_meta.sha256_hash.is_empty(), "Archive must have calculated SHA-256");

    // 9. Test Duplicate Protection & Transaction Creation
    let dup_check = db.check_duplicate(po_folder_name, "fingerprint_123", &archive_meta.sha256_hash)
        .expect("Duplicate check failed");
    assert!(dup_check.is_none(), "First run should not be duplicate");

    let tx = PoTransaction {
        id: uuid::Uuid::new_v4().to_string(),
        job_id: uuid::Uuid::new_v4().to_string(),
        po_number: po_folder_name.to_string(),
        folder_fingerprint: "fingerprint_123".to_string(),
        archive_sha256: archive_meta.sha256_hash.clone(),
        company_name: matched.company_name.clone(),
        recipient_email: matched.email.clone(),
        status: "sent".to_string(),
        gas_execution_id: Some("exec_xyz789".to_string()),
        error_message: None,
        sent_at: chrono::Utc::now().to_rfc3339(),
    };
    db.record_transaction(&tx).expect("Failed to record transaction");

    // Re-verify duplicate protection blocks second processing
    let dup_check_after = db.check_duplicate(po_folder_name, "fingerprint_123", &archive_meta.sha256_hash)
        .expect("Duplicate check failed");
    assert!(dup_check_after.is_some(), "Duplicate detection must prevent double sending");
    assert_eq!(dup_check_after.unwrap().po_number, po_folder_name);

    // 10. Test Safe Folder Move to Sent
    let sent_target = sent_dir.join(po_folder_name);
    fs::rename(&po_incoming_path, &sent_target).expect("Failed to move to Sent directory");
    assert!(sent_target.exists(), "Folder should now reside in Sent directory");
    assert!(!po_incoming_path.exists(), "Incoming folder should no longer exist");
}
