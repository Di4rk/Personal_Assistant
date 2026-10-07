use diark_core_lib::commands::portal_auth::{
    classify_remote_navigation, NavigationDecision, RemoteOriginPolicy, MAX_SSO_PAYLOAD_SIZE,
};
use tauri::Url;

#[test]
fn test_remote_webview_security_portal_origin_policy_allows_only_trusted_hosts() {
    let policy = RemoteOriginPolicy::for_portal();

    // Valid HTTPS endpoints for Portal flow
    let trusted_urls = [
        "https://portal.uit.edu.vn",
        "https://portal.uit.edu.vn/dashboard",
        "https://portal.uit.edu.vn:443/student/index",
        "https://sso.uit.edu.vn/realms/UIT/protocol/openid-connect/auth",
        "https://auth.uit.edu.vn/login",
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
        "https://login.live.com/oauth20_authorize.srf",
    ];

    for url_str in trusted_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::AllowTrustedHttps,
            "Portal should allow trusted URL: {url_str}"
        );
    }

    // Lookalike domains, unauthorized subdomains, and external domains
    let rejected_urls = [
        "https://portal.uit.edu.vn.evil.com",
        "https://evil-portal.uit.edu.vn",
        "https://attacker.com/portal.uit.edu.vn",
        "https://courses.uit.edu.vn",        // Moodle host shouldn't be allowed in Portal
        "https://khmt.uit.edu.vn",           // Wecode host shouldn't be allowed in Portal
        "https://sub.portal.uit.edu.vn",     // Subdomain not explicitly allowlisted
        "http://portal.uit.edu.vn",          // Plain HTTP must be blocked
        "https://portal.uit.edu.vn:8443",    // Non-standard port must be blocked
        "https://fake-login.microsoftonline.com",
    ];

    for url_str in rejected_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::Reject,
            "Portal should reject unauthorized URL: {url_str}"
        );
    }
}

#[test]
fn test_remote_webview_security_wecode_origin_policy_allows_only_trusted_hosts() {
    let policy = RemoteOriginPolicy::for_wecode();

    // Valid HTTPS endpoints for Wecode flow
    let trusted_urls = [
        "https://khmt.uit.edu.vn",
        "https://khmt.uit.edu.vn/wecode/login",
        "https://khmt.uit.edu.vn:443/wecode/dashboard",
    ];

    for url_str in trusted_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::AllowTrustedHttps,
            "Wecode should allow trusted URL: {url_str}"
        );
    }

    // Cross-target hosts, lookalike domains, plain HTTP
    let rejected_urls = [
        "https://portal.uit.edu.vn",
        "https://login.microsoftonline.com",
        "https://courses.uit.edu.vn",
        "https://khmt.uit.edu.vn.attacker.com",
        "https://attacker-khmt.uit.edu.vn",
        "http://khmt.uit.edu.vn/wecode",
        "https://khmt.uit.edu.vn:8080",
    ];

    for url_str in rejected_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::Reject,
            "Wecode should reject unauthorized URL: {url_str}"
        );
    }
}

#[test]
fn test_remote_webview_security_moodle_origin_policy_allows_only_trusted_hosts() {
    let policy = RemoteOriginPolicy::for_moodle();

    // Valid HTTPS endpoints for Moodle flow
    let trusted_urls = [
        "https://courses.uit.edu.vn",
        "https://courses.uit.edu.vn/my/",
        "https://courses.uit.edu.vn/course/view.php?id=123",
        "https://sso.uit.edu.vn/realms/UIT/protocol/openid-connect/auth",
        "https://auth.uit.edu.vn/login",
        "https://login.microsoftonline.com/common/oauth2/authorize",
        "https://login.live.com/login.srf",
    ];

    for url_str in trusted_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::AllowTrustedHttps,
            "Moodle should allow trusted URL: {url_str}"
        );
    }

    // Cross-target hosts, lookalikes, plain HTTP
    let rejected_urls = [
        "https://khmt.uit.edu.vn",
        "https://portal.uit.edu.vn",
        "https://courses.uit.edu.vn.attacker.com",
        "http://courses.uit.edu.vn",
        "https://courses.uit.edu.vn:9000",
    ];

    for url_str in rejected_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::Reject,
            "Moodle should reject unauthorized URL: {url_str}"
        );
    }
}

#[test]
fn test_remote_webview_security_scheme_and_callback_interception() {
    let policy = RemoteOriginPolicy::for_portal();

    // Legitimate diark-sso internal scheme callbacks
    let intercept_urls = [
        "diark-sso://callback#target=portal&token=abc",
        "diark-sso://partial#target=portal&stage=courses&payload=xyz",
        "diark-sso://failed?reason=timeout",
    ];

    for url_str in intercept_urls {
        let url = Url::parse(url_str).expect("Valid URL");
        assert_eq!(
            classify_remote_navigation(&url, &policy),
            NavigationDecision::InterceptDiarkSso,
            "diark-sso scheme must be intercepted by Rust: {url_str}"
        );
    }

    // Dangerous and unapproved schemes must be rejected
    let dangerous_schemes = [
        "javascript:alert(document.cookie)",
        "data:text/html,<html><script>alert(1)</script></html>",
        "file:///C:/Windows/System32/cmd.exe",
        "blob:https://portal.uit.edu.vn/1234-5678",
        "diark-sso://unknown-action",
        "chrome://settings",
        "about:blank",
    ];

    for url_str in dangerous_schemes {
        if let Ok(url) = Url::parse(url_str) {
            assert_eq!(
                classify_remote_navigation(&url, &policy),
                NavigationDecision::Reject,
                "Dangerous scheme must be rejected: {url_str}"
            );
        }
    }
}

#[test]
fn test_remote_webview_security_payload_size_threshold() {
    assert_eq!(MAX_SSO_PAYLOAD_SIZE, 10 * 1024 * 1024);
}

#[test]
fn test_remote_webview_security_capability_isolation_default_json() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let default_json_path = std::path::Path::new(manifest_dir)
        .join("capabilities")
        .join("default.json");

    let content = std::fs::read_to_string(&default_json_path)
        .expect("Must read capabilities/default.json");
    let json: serde_json::Value =
        serde_json::from_str(&content).expect("Valid JSON format in default.json");

    let windows = json
        .get("windows")
        .and_then(|w| w.as_array())
        .expect("default.json must have windows array");

    // Only 'main' window is permitted to possess Tauri IPC capabilities
    assert_eq!(
        windows.len(),
        1,
        "default.json must only assign capabilities to exactly 1 window ('main')"
    );
    assert_eq!(
        windows[0].as_str(),
        Some("main"),
        "default.json window must be 'main'"
    );

    // Remote SSO labels must NEVER be present in default capability
    let disallowed_labels = [
        "portal-sso-login",
        "wecode-sso-login",
        "moodle-sso-login",
        "portal-sync-silent",
        "wecode-sync-silent",
        "moodle-sync-silent",
    ];

    for label in disallowed_labels {
        assert!(
            !windows.iter().any(|w| w.as_str() == Some(label)),
            "Remote label '{label}' must not have core capabilities assigned!"
        );
    }
}

#[test]
fn test_remote_webview_security_tauri_conf_csp_configured() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let tauri_conf_path = std::path::Path::new(manifest_dir).join("tauri.conf.json");

    let content = std::fs::read_to_string(&tauri_conf_path)
        .expect("Must read tauri.conf.json");
    let json: serde_json::Value =
        serde_json::from_str(&content).expect("Valid JSON in tauri.conf.json");

    let csp = json
        .get("app")
        .and_then(|a| a.get("security"))
        .and_then(|s| s.get("csp"))
        .and_then(|c| c.as_str())
        .expect("tauri.conf.json must define app.security.csp as a string");

    assert!(
        !csp.is_empty(),
        "CSP string must not be empty or null"
    );
    assert!(
        csp.contains("default-src 'self'"),
        "CSP must define default-src 'self'"
    );
    assert!(
        !csp.contains("default-src *"),
        "CSP must not allow wildcard default-src"
    );
}
