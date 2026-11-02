//! The business facts a site states about itself, stored once under `business` in `openblog.json`
//! (ADR 0305).
//!
//! The block is data, never markup: every field is a bounded line of text, a strict phone number,
//! a strict clock time, a flag, or one choice from a closed list. Pages, the footer, the Landing
//! page's Business facts section and the `LocalBusiness` structured data all read this one value,
//! so nothing on the site can contradict itself. An unset block is the default and adds nothing to
//! any page: a site that never sets it builds exactly as before.
//!
//! The stored object is versioned and conservative: only [`BUSINESS_VERSION`] is read or written,
//! a newer one is refused (the file is not changed), and fields this release does not define are
//! kept as written so saving never drops a newer engine's settings.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};

use crate::escape::{attr, text};

/// The only stored version this release reads or writes.
pub const BUSINESS_VERSION: u64 = 1;

const MAX_NAME: usize = 120;
const MAX_LICENSE: usize = 40;
const MAX_ISSUER: usize = 80;
const MAX_EMAIL: usize = 254;
const FIRST_YEAR: i64 = 1800;
const LAST_YEAR: i64 = 2100;

/// A day of the week, in the order a week is listed (Monday first).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl Weekday {
    pub const ALL: [Weekday; 7] = [
        Weekday::Monday,
        Weekday::Tuesday,
        Weekday::Wednesday,
        Weekday::Thursday,
        Weekday::Friday,
        Weekday::Saturday,
        Weekday::Sunday,
    ];

    /// The key as the file writes it.
    pub fn id(self) -> &'static str {
        match self {
            Self::Monday => "monday",
            Self::Tuesday => "tuesday",
            Self::Wednesday => "wednesday",
            Self::Thursday => "thursday",
            Self::Friday => "friday",
            Self::Saturday => "saturday",
            Self::Sunday => "sunday",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Monday => "Monday",
            Self::Tuesday => "Tuesday",
            Self::Wednesday => "Wednesday",
            Self::Thursday => "Thursday",
            Self::Friday => "Friday",
            Self::Saturday => "Saturday",
            Self::Sunday => "Sunday",
        }
    }

    fn short(self) -> &'static str {
        &self.label()[..3]
    }

    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|day| day.id() == id)
    }
}

/// What a weekday looks like: shut, or open between two times on the same day.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DayHours {
    Closed,
    /// Minutes after midnight. `close` is greater than `open` and at most 1440 (24:00).
    Open {
        open: u16,
        close: u16,
    },
}

/// A way a customer may pay. A closed list: no card numbers or accounts, only the kinds of payment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PaymentMethod {
    Cash,
    Check,
    CreditCard,
    DebitCard,
    BankTransfer,
    MobilePayment,
    Financing,
}

impl PaymentMethod {
    pub const ALL: [PaymentMethod; 7] = [
        Self::Cash,
        Self::Check,
        Self::CreditCard,
        Self::DebitCard,
        Self::BankTransfer,
        Self::MobilePayment,
        Self::Financing,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Cash => "cash",
            Self::Check => "check",
            Self::CreditCard => "credit-card",
            Self::DebitCard => "debit-card",
            Self::BankTransfer => "bank-transfer",
            Self::MobilePayment => "mobile-payment",
            Self::Financing => "financing",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Cash => "Cash",
            Self::Check => "Check",
            Self::CreditCard => "Credit card",
            Self::DebitCard => "Debit card",
            Self::BankTransfer => "Bank transfer",
            Self::MobilePayment => "Mobile payment",
            Self::Financing => "Financing",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|method| method.id() == id)
    }

    pub fn ids() -> Vec<&'static str> {
        Self::ALL.iter().map(|method| method.id()).collect()
    }
}

/// The validated business facts. Every field is optional; the default is "nothing stated".
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BusinessConfig {
    pub legal_name: String,
    pub display_name: String,
    /// A trade id the site knows (checked with the config, not here).
    pub trade: String,
    /// E.164: `+` and 8 to 15 digits.
    pub phone: String,
    pub email: String,
    pub hours: BTreeMap<Weekday, DayHours>,
    pub license_number: String,
    pub license_issuer: String,
    pub insured: bool,
    pub payment_methods: Vec<PaymentMethod>,
    pub founded_year: Option<u16>,
    /// Fields this engine does not know, kept so saving never drops a newer engine's settings.
    pub extra: BTreeMap<String, Value>,
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "nothing",
        Value::Bool(_) => "a true/false value",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// A phone in E.164, or the plain reason it is not.
pub fn check_phone(phone: &str) -> Result<(), String> {
    let digits = phone.strip_prefix('+').unwrap_or("");
    if digits.len() < 8
        || digits.len() > 15
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || digits.starts_with('0')
    {
        return Err(
            "phone must include the country code and digits only, like +14155550123".into(),
        );
    }
    Ok(())
}

/// Turns what an owner types into E.164: separators are dropped, and ten digits with no country
/// code are read as a US or Canada number. Anything else must start with `+`.
pub fn normalize_phone_input(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let plus = trimmed.starts_with('+');
    let digits: String = trimmed.chars().filter(char::is_ascii_digit).collect();
    let cleaned_ok = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | ' ' | '-' | '(' | ')' | '.'));
    if !cleaned_ok {
        return trimmed.to_string();
    }
    if plus {
        format!("+{digits}")
    } else if digits.len() == 10 {
        format!("+1{digits}")
    } else if digits.len() == 11 && digits.starts_with('1') {
        format!("+{digits}")
    } else {
        trimmed.to_string()
    }
}

/// An E.164 number as a reader expects to see it: `(415) 555-0123` for US and Canada numbers, the
/// stored form otherwise.
pub fn format_phone(phone: &str) -> String {
    match phone.strip_prefix("+1") {
        Some(national) if national.len() == 10 && national.bytes().all(|b| b.is_ascii_digit()) => {
            format!(
                "({}) {}-{}",
                &national[..3],
                &national[3..6],
                &national[6..]
            )
        }
        _ => phone.to_string(),
    }
}

fn parse_clock(value: &Value, what: &str, errors: &mut Vec<String>) -> Option<u16> {
    let Some(text) = value.as_str() else {
        errors.push(format!(
            "hours: {what} must be a time like 08:00, not {}",
            kind(value)
        ));
        return None;
    };
    let bytes = text.as_bytes();
    let well_formed = bytes.len() == 5
        && bytes[2] == b':'
        && bytes[..2].iter().chain(&bytes[3..]).all(u8::is_ascii_digit);
    if !well_formed {
        errors.push(format!(
            "hours: {what} must be a 24-hour time like 08:00 or 17:30"
        ));
        return None;
    }
    let hours: u16 = text[..2].parse().unwrap_or(99);
    let minutes: u16 = text[3..].parse().unwrap_or(99);
    let total = hours * 60 + minutes;
    if minutes > 59 || total > 1440 || (hours == 24 && minutes != 0) {
        errors.push(format!(
            "hours: {what} must be between 00:00 and 24:00 with minutes under 60"
        ));
        return None;
    }
    Some(total)
}

/// `h:mm am` for a minute of the day (`24:00` is midnight).
pub fn clock_label(minutes: u16) -> String {
    if minutes >= 1440 {
        return "midnight".into();
    }
    if minutes == 720 {
        return "noon".into();
    }
    let hour = minutes / 60;
    let (twelve, suffix) = match hour {
        0 => (12, "am"),
        1..=11 => (hour, "am"),
        12 => (12, "pm"),
        _ => (hour - 12, "pm"),
    };
    format!("{twelve}:{:02} {suffix}", minutes % 60)
}

fn clock_value(minutes: u16) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

fn line(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
    errors: &mut Vec<String>,
) -> Option<String> {
    let value = object.get(key)?;
    if value.is_null() {
        return None;
    }
    let Some(raw) = value.as_str() else {
        errors.push(format!("{key} must be text, not {}", kind(value)));
        return None;
    };
    let trimmed = raw.trim();
    if trimmed.chars().any(char::is_control) {
        errors.push(format!("{key} must be one line of plain text"));
        return None;
    }
    if trimmed.chars().count() > max {
        errors.push(format!("{key} must be at most {max} characters"));
        return None;
    }
    Some(trimmed.to_string())
}

fn is_email(value: &str) -> bool {
    if value.len() > MAX_EMAIL || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
        && domain.contains('.')
        && !domain.starts_with(['.', '-'])
        && !domain.ends_with(['.', '-'])
        && !domain.contains("..")
        && domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
}

impl BusinessConfig {
    /// True when nothing is stated and nothing is preserved: no page changes.
    pub fn is_default(&self) -> bool {
        *self == BusinessConfig::default()
    }

    /// The name shown to readers: the display name, else the legal name.
    pub fn name(&self) -> &str {
        if self.display_name.is_empty() {
            &self.legal_name
        } else {
            &self.display_name
        }
    }

    /// Whether there is anything to show to a reader (preserved unknown fields are never shown).
    pub fn has_public_facts(&self) -> bool {
        !self.name().is_empty()
            || !self.phone.is_empty()
            || !self.email.is_empty()
            || !self.hours.is_empty()
            || !self.license_number.is_empty()
            || self.insured
            || !self.payment_methods.is_empty()
            || self.founded_year.is_some()
    }

    /// Validate a stored or submitted `business` object. Every problem is reported, in plain words.
    pub fn from_value(value: &Value) -> Result<BusinessConfig, Vec<String>> {
        let object = match value {
            Value::Null => return Ok(BusinessConfig::default()),
            Value::Object(object) => object,
            other => {
                return Err(vec![format!(
                    "business must be an object, not {}",
                    kind(other)
                )])
            }
        };
        let mut errors = Vec::new();
        match object.get("version") {
            None | Some(Value::Null) => {}
            Some(Value::Number(n)) if n.as_u64() == Some(BUSINESS_VERSION) => {}
            Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v > BUSINESS_VERSION) => errors
                .push(
                    "these facts were saved by a newer version of open.blog; update before editing them"
                        .to_string(),
                ),
            Some(_) => errors.push(format!("version must be {BUSINESS_VERSION}")),
        }
        let mut business = BusinessConfig::default();
        let mut errs = Vec::new();
        if let Some(v) = line(object, "legalName", MAX_NAME, &mut errs) {
            business.legal_name = v;
        }
        if let Some(v) = line(object, "displayName", MAX_NAME, &mut errs) {
            business.display_name = v;
        }
        if let Some(v) = line(object, "trade", MAX_ISSUER, &mut errs) {
            business.trade = v.to_ascii_lowercase();
        }
        if let Some(v) = line(object, "licenseNumber", MAX_LICENSE, &mut errs) {
            business.license_number = v;
        }
        if let Some(v) = line(object, "licenseIssuer", MAX_ISSUER, &mut errs) {
            business.license_issuer = v;
        }
        errors.append(&mut errs);
        if let Some(phone) = line(object, "phone", 20, &mut errors) {
            if !phone.is_empty() {
                match check_phone(&phone) {
                    Ok(()) => business.phone = phone,
                    Err(message) => errors.push(message),
                }
            }
        }
        if let Some(email) = line(object, "email", MAX_EMAIL, &mut errors) {
            if !email.is_empty() {
                if is_email(&email) {
                    business.email = email;
                } else {
                    errors.push("email must be one address, like office@example.com".into());
                }
            }
        }
        if !business.license_issuer.is_empty() && business.license_number.is_empty() {
            errors.push("licenseIssuer needs a licenseNumber to go with it".into());
        }
        match object.get("insured") {
            None | Some(Value::Null) => {}
            Some(Value::Bool(flag)) => business.insured = *flag,
            Some(other) => errors.push(format!(
                "insured must be true or false, not {}",
                kind(other)
            )),
        }
        match object.get("foundedYear") {
            None | Some(Value::Null) => {}
            Some(Value::Number(n)) => match n.as_i64() {
                Some(year) if (FIRST_YEAR..=LAST_YEAR).contains(&year) => {
                    business.founded_year = Some(year as u16)
                }
                _ => errors.push(format!(
                    "foundedYear must be a four-digit year between {FIRST_YEAR} and {LAST_YEAR}"
                )),
            },
            Some(other) => errors.push(format!(
                "foundedYear must be a year like 1998, not {}",
                kind(other)
            )),
        }
        match object.get("paymentMethods") {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    match item.as_str().and_then(PaymentMethod::parse) {
                        Some(method) if !business.payment_methods.contains(&method) => {
                            business.payment_methods.push(method)
                        }
                        Some(_) => {}
                        None => errors.push(format!(
                            "paymentMethods can only list: {}",
                            PaymentMethod::ids().join(", ")
                        )),
                    }
                }
            }
            Some(other) => errors.push(format!(
                "paymentMethods must be a list, not {}",
                kind(other)
            )),
        }
        match object.get("hours") {
            None | Some(Value::Null) => {}
            Some(Value::Object(days)) => {
                for (key, day) in days {
                    let Some(weekday) = Weekday::parse(key) else {
                        errors.push(format!(
                            "hours can only name the days {}",
                            Weekday::ALL.map(Weekday::id).join(", ")
                        ));
                        continue;
                    };
                    match parse_day(weekday, day) {
                        Ok(Some(hours)) => {
                            business.hours.insert(weekday, hours);
                        }
                        Ok(None) => {}
                        Err(mut problems) => errors.append(&mut problems),
                    }
                }
            }
            Some(other) => errors.push(format!("hours must list the days, not {}", kind(other))),
        }
        const KNOWN: [&str; 12] = [
            "version",
            "foundedYear",
            "legalName",
            "displayName",
            "trade",
            "phone",
            "email",
            "hours",
            "licenseNumber",
            "licenseIssuer",
            "insured",
            "paymentMethods",
        ];
        for (key, value) in object {
            if !KNOWN.contains(&key.as_str()) {
                business.extra.insert(key.clone(), value.clone());
            }
        }
        if errors.is_empty() {
            Ok(business)
        } else {
            Err(errors
                .into_iter()
                .map(|e| format!("business: {e}"))
                .collect())
        }
    }

    /// The stored shape: versioned, with only the stated fields, empty when the default.
    pub fn to_value(&self) -> Value {
        if self.is_default() {
            return Value::Object(Map::new());
        }
        let mut object = Map::new();
        for (key, value) in &self.extra {
            object.insert(key.clone(), value.clone());
        }
        object.insert("version".into(), Value::from(BUSINESS_VERSION));
        let mut put = |key: &str, value: &str| {
            if !value.is_empty() {
                object.insert(key.into(), Value::String(value.to_string()));
            }
        };
        put("legalName", &self.legal_name);
        put("displayName", &self.display_name);
        put("trade", &self.trade);
        put("phone", &self.phone);
        put("email", &self.email);
        put("licenseNumber", &self.license_number);
        put("licenseIssuer", &self.license_issuer);
        if self.insured {
            object.insert("insured".into(), Value::Bool(true));
        }
        if let Some(year) = self.founded_year {
            object.insert("foundedYear".into(), Value::from(year));
        }
        if !self.payment_methods.is_empty() {
            object.insert(
                "paymentMethods".into(),
                Value::Array(
                    self.payment_methods
                        .iter()
                        .map(|m| Value::String(m.id().into()))
                        .collect(),
                ),
            );
        }
        if !self.hours.is_empty() {
            let mut days = Map::new();
            for (day, hours) in &self.hours {
                days.insert(
                    day.id().into(),
                    match hours {
                        DayHours::Closed => serde_json::json!({ "closed": true }),
                        DayHours::Open { open, close } => serde_json::json!({
                            "open": clock_value(*open),
                            "close": clock_value(*close),
                        }),
                    },
                );
            }
            object.insert("hours".into(), Value::Object(days));
        }
        Value::Object(object)
    }

    /// The hours in reading order with consecutive days that share hours joined:
    /// `("Mon to Fri", "8:00 am to 5:00 pm")`. Days with nothing stated are skipped.
    pub fn hours_rows(&self) -> Vec<(String, String)> {
        let mut rows: Vec<(Vec<Weekday>, DayHours)> = Vec::new();
        for day in Weekday::ALL {
            let Some(hours) = self.hours.get(&day).copied() else {
                continue;
            };
            match rows.last_mut() {
                Some((days, last))
                    if *last == hours
                        && days.last().is_some_and(|d| {
                            Weekday::ALL.iter().position(|x| x == d).map(|i| i + 1)
                                == Weekday::ALL.iter().position(|x| *x == day)
                        }) =>
                {
                    days.push(day)
                }
                _ => rows.push((vec![day], hours)),
            }
        }
        rows.into_iter()
            .map(|(days, hours)| {
                let label = match days.as_slice() {
                    [one] => one.label().to_string(),
                    [first, .., last] if days.len() == 2 => {
                        format!("{} and {}", first.label(), last.label())
                    }
                    [first, .., last] => format!("{} to {}", first.short(), last.short()),
                    [] => String::new(),
                };
                let value = match hours {
                    DayHours::Closed => "Closed".to_string(),
                    DayHours::Open { open, close } => {
                        format!("{} to {}", clock_label(open), clock_label(close))
                    }
                };
                (label, value)
            })
            .collect()
    }

    /// The badge text a licensed and insured business earns, or nothing.
    pub fn badge(&self) -> Option<&'static str> {
        match (!self.license_number.is_empty(), self.insured) {
            (true, true) => Some("Licensed and insured"),
            (true, false) => Some("Licensed"),
            (false, true) => Some("Insured"),
            (false, false) => None,
        }
    }

    /// The facts as a theme-neutral block (`ob-business`). Nothing is rendered when nothing is
    /// stated. Every value is escaped; the phone and email become links because the owner chose
    /// to publish them.
    pub fn block_html(&self) -> String {
        if !self.has_public_facts() {
            return String::new();
        }
        let mut h = String::from("<div class=\"ob-business\">\n");
        if !self.name().is_empty() {
            h.push_str(&format!(
                "<p class=\"ob-business-name\">{}</p>\n",
                text(self.name())
            ));
        }
        if let Some(badge) = self.badge() {
            h.push_str(&format!(
                "<p class=\"ob-business-badge\"><span class=\"ob-badge\">{}</span></p>\n",
                badge
            ));
        }
        let mut contact = String::new();
        if !self.phone.is_empty() {
            contact.push_str(&format!(
                "<li class=\"ob-business-phone\"><a href=\"tel:{}\">{}</a></li>\n",
                attr(&self.phone),
                text(&format_phone(&self.phone))
            ));
        }
        if !self.email.is_empty() {
            contact.push_str(&format!(
                "<li class=\"ob-business-email\"><a href=\"mailto:{}\">{}</a></li>\n",
                attr(&self.email),
                text(&self.email)
            ));
        }
        if !contact.is_empty() {
            h.push_str(&format!(
                "<ul class=\"ob-business-contact\">\n{contact}</ul>\n"
            ));
        }
        let rows = self.hours_rows();
        if !rows.is_empty() {
            h.push_str("<dl class=\"ob-business-hours\">\n");
            for (days, hours) in rows {
                h.push_str(&format!(
                    "<div><dt>{}</dt><dd>{}</dd></div>\n",
                    text(&days),
                    text(&hours)
                ));
            }
            h.push_str("</dl>\n");
        }
        let mut notes = Vec::new();
        if !self.license_number.is_empty() {
            let issuer = if self.license_issuer.is_empty() {
                String::new()
            } else {
                format!(", {}", text(&self.license_issuer))
            };
            notes.push(format!("License {}{issuer}", text(&self.license_number)));
        }
        if !self.payment_methods.is_empty() {
            let labels: Vec<&str> = self.payment_methods.iter().map(|m| m.label()).collect();
            notes.push(format!("We accept {}", text(&labels.join(", "))));
        }
        if let Some(year) = self.founded_year {
            notes.push(format!("Serving customers since {year}"));
        }
        if !notes.is_empty() {
            h.push_str("<ul class=\"ob-business-notes\">\n");
            for note in notes {
                h.push_str(&format!("<li>{note}</li>\n"));
            }
            h.push_str("</ul>\n");
        }
        h.push_str("</div>\n");
        h
    }

    /// The schema.org type for the business's trade: a subtype where schema.org has one.
    pub fn schema_type(&self) -> &'static str {
        schema_type_for_trade(&self.trade)
    }

    /// `LocalBusiness` structured data from the stated facts only. `id` is the node's `@id` and
    /// `url` the site's public address; `site_name` stands in when no name is stated.
    pub fn local_business_json_ld(&self, id: &str, url: &str, site_name: &str) -> Value {
        let mut node = Map::new();
        node.insert("@context".into(), "https://schema.org".into());
        node.insert("@type".into(), self.schema_type().into());
        node.insert("@id".into(), id.into());
        let name = if self.name().is_empty() {
            site_name
        } else {
            self.name()
        };
        node.insert("name".into(), name.into());
        if !self.legal_name.is_empty() && self.legal_name != name {
            node.insert("legalName".into(), self.legal_name.clone().into());
        }
        node.insert("url".into(), url.into());
        if !self.phone.is_empty() {
            node.insert("telephone".into(), self.phone.clone().into());
        }
        if !self.email.is_empty() {
            node.insert("email".into(), self.email.clone().into());
        }
        if let Some(year) = self.founded_year {
            node.insert("foundingDate".into(), year.to_string().into());
        }
        let specs: Vec<Value> = self
            .hours
            .iter()
            .filter_map(|(day, hours)| match hours {
                DayHours::Closed => None,
                DayHours::Open { open, close } => Some(serde_json::json!({
                    "@type": "OpeningHoursSpecification",
                    "dayOfWeek": format!("https://schema.org/{}", day.label()),
                    "opens": clock_value(*open),
                    "closes": if *close >= 1440 { "23:59".to_string() } else { clock_value(*close) },
                })),
            })
            .collect();
        if !specs.is_empty() {
            node.insert("openingHoursSpecification".into(), Value::Array(specs));
        }
        if !self.payment_methods.is_empty() {
            let labels: Vec<&str> = self.payment_methods.iter().map(|m| m.label()).collect();
            node.insert("paymentAccepted".into(), labels.join(", ").into());
        }
        if !self.license_number.is_empty() {
            let mut credential = serde_json::json!({
                "@type": "EducationalOccupationalCredential",
                "credentialCategory": "license",
                "identifier": self.license_number,
            });
            if !self.license_issuer.is_empty() {
                credential["recognizedBy"] =
                    serde_json::json!({ "@type": "Organization", "name": self.license_issuer });
            }
            node.insert("hasCredential".into(), credential);
        }
        Value::Object(node)
    }
}

/// The schema.org type for a trade id. Trades schema.org has no type for map to the closest
/// parent (`HomeAndConstructionBusiness`), and anything unknown is a plain `LocalBusiness`.
pub fn schema_type_for_trade(trade: &str) -> &'static str {
    match trade {
        "general-contractor" => "GeneralContractor",
        "excavation" | "flooring" | "landscaping" => "HomeAndConstructionBusiness",
        "mobile-mechanic" => "AutoRepair",
        "auto-body-paint" => "AutoBodyShop",
        "roofing" => "RoofingContractor",
        "plumbing" => "Plumber",
        "electrical" => "Electrician",
        "painting" => "HousePainter",
        "hvac" => "HVACBusiness",
        "locksmith" => "Locksmith",
        _ => "LocalBusiness",
    }
}

fn parse_day(day: Weekday, value: &Value) -> Result<Option<DayHours>, Vec<String>> {
    let label = day.label();
    let object = match value {
        Value::Null => return Ok(None),
        Value::Object(object) => object,
        other => {
            return Err(vec![format!(
                "hours: {label} must be closed or have an open and a close time, not {}",
                kind(other)
            )])
        }
    };
    let mut errors = Vec::new();
    for key in object.keys() {
        if !matches!(key.as_str(), "open" | "close" | "closed") {
            errors.push(format!(
                "hours: {label} can only have open, close or closed"
            ));
        }
    }
    let closed = match object.get("closed") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => {
            errors.push(format!("hours: {label} closed must be true or false"));
            false
        }
    };
    if closed {
        if object.get("open").is_some_and(|v| !v.is_null())
            || object.get("close").is_some_and(|v| !v.is_null())
        {
            errors.push(format!(
                "hours: {label} is closed, so it cannot also have an open or close time"
            ));
        }
        return if errors.is_empty() {
            Ok(Some(DayHours::Closed))
        } else {
            Err(errors)
        };
    }
    let open = object.get("open").filter(|v| !v.is_null());
    let close = object.get("close").filter(|v| !v.is_null());
    let (Some(open), Some(close)) = (open, close) else {
        errors.push(format!(
            "hours: {label} needs both an open and a close time, or mark it closed"
        ));
        return Err(errors);
    };
    let open = parse_clock(open, &format!("{label} open"), &mut errors);
    let close = parse_clock(close, &format!("{label} close"), &mut errors);
    match (open, close) {
        (Some(open), Some(close)) if errors.is_empty() => {
            if close <= open {
                Err(vec![format!(
                    "hours: {label} must close after it opens (a day that runs past midnight is not supported; use 24:00 to close at midnight)"
                )])
            } else {
                Ok(Some(DayHours::Open { open, close }))
            }
        }
        _ => Err(errors),
    }
}

impl Serialize for BusinessConfig {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for BusinessConfig {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        BusinessConfig::from_value(&value)
            .map_err(|errors| serde::de::Error::custom(errors.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn err(value: Value) -> String {
        BusinessConfig::from_value(&value).unwrap_err().join("; ")
    }

    #[test]
    fn nothing_stated_is_the_default_and_stores_nothing() {
        for empty in [json!(null), json!({}), json!({"version": 1})] {
            let business = BusinessConfig::from_value(&empty).unwrap();
            assert!(business.is_default());
            assert_eq!(business.to_value(), json!({}));
            assert_eq!(business.block_html(), "");
        }
    }

    #[test]
    fn a_full_block_round_trips() {
        let value = json!({
            "version": 1,
            "legalName": "Maple Falls Flooring LLC",
            "displayName": "Maple Falls Flooring",
            "trade": "flooring",
            "phone": "+13605550142",
            "email": "office@example.com",
            "hours": {
                "monday": {"open": "08:00", "close": "17:00"},
                "saturday": {"open": "09:00", "close": "12:30"},
                "sunday": {"closed": true}
            },
            "licenseNumber": "MAPLEF*123",
            "licenseIssuer": "WA L&I",
            "insured": true,
            "paymentMethods": ["cash", "credit-card"],
            "foundedYear": 1998,
            "x-future": {"keep": 1}
        });
        let business = BusinessConfig::from_value(&value).unwrap();
        assert_eq!(business.to_value(), value);
        assert_eq!(business.extra["x-future"], json!({"keep": 1}));
    }

    #[test]
    fn a_phone_must_be_e164_and_says_how_to_fix_it() {
        for bad in [
            "555-0142",
            "+0123456789",
            "+1 360 555 0142",
            "13605550142",
            "+123",
        ] {
            let message = err(json!({ "phone": bad }));
            assert!(
                message.contains("business: phone must include the country code"),
                "{bad}: {message}"
            );
        }
        assert!(BusinessConfig::from_value(&json!({"phone": "+442079460958"})).is_ok());
    }

    #[test]
    fn typed_phones_are_normalized_before_they_are_stored() {
        assert_eq!(normalize_phone_input("(360) 555-0142"), "+13605550142");
        assert_eq!(normalize_phone_input("1 360 555 0142"), "+13605550142");
        assert_eq!(normalize_phone_input("+44 20 7946 0958"), "+442079460958");
        assert_eq!(normalize_phone_input("call me"), "call me");
        assert_eq!(format_phone("+13605550142"), "(360) 555-0142");
        assert_eq!(format_phone("+442079460958"), "+442079460958");
    }

    #[test]
    fn hours_fail_in_plain_words() {
        assert!(
            err(json!({"hours": {"funday": {"closed": true}}})).contains("can only name the days")
        );
        assert!(
            err(json!({"hours": {"monday": {"open": "8am", "close": "17:00"}}}))
                .contains("24-hour time like 08:00")
        );
        assert!(
            err(json!({"hours": {"monday": {"open": "18:00", "close": "17:00"}}}))
                .contains("must close after it opens")
        );
        assert!(err(json!({"hours": {"monday": {"open": "08:00"}}})).contains("needs both"));
        assert!(
            err(json!({"hours": {"monday": {"closed": true, "open": "08:00"}}}))
                .contains("closed, so it cannot also")
        );
        assert!(
            err(json!({"hours": {"monday": {"open": "08:70", "close": "17:00"}}}))
                .contains("minutes under 60")
        );
        assert!(BusinessConfig::from_value(
            &json!({"hours": {"monday": {"open": "00:00", "close": "24:00"}}})
        )
        .is_ok());
    }

    #[test]
    fn other_fields_are_closed_choices_or_bounded_lines() {
        assert!(err(json!({"paymentMethods": ["cash", "bitcoin"]}))
            .contains("paymentMethods can only list"));
        assert!(err(json!({"foundedYear": 1066})).contains("foundedYear"));
        assert!(err(json!({"email": "not an address"})).contains("email must be one address"));
        assert!(err(json!({"insured": "yes"})).contains("true or false"));
        assert!(err(json!({"legalName": "a\nb"})).contains("one line"));
        assert!(err(json!({"licenseIssuer": "State"})).contains("needs a licenseNumber"));
        assert!(err(json!({"version": 2})).contains("newer version"));
        assert!(err(json!("text")).contains("must be an object"));
    }

    #[test]
    fn hours_are_grouped_for_reading() {
        let business = BusinessConfig::from_value(&json!({"hours": {
            "monday": {"open": "08:00", "close": "17:00"},
            "tuesday": {"open": "08:00", "close": "17:00"},
            "wednesday": {"open": "08:00", "close": "17:00"},
            "friday": {"open": "08:00", "close": "17:00"},
            "saturday": {"open": "09:00", "close": "12:00"},
            "sunday": {"closed": true}
        }}))
        .unwrap();
        assert_eq!(
            business.hours_rows(),
            vec![
                ("Mon to Wed".to_string(), "8:00 am to 5:00 pm".to_string()),
                ("Friday".to_string(), "8:00 am to 5:00 pm".to_string()),
                ("Saturday".to_string(), "9:00 am to noon".to_string()),
                ("Sunday".to_string(), "Closed".to_string()),
            ]
        );
    }

    #[test]
    fn the_block_escapes_everything_and_names_the_badge() {
        let business = BusinessConfig::from_value(&json!({
            "displayName": "A <b>&</b> B",
            "licenseNumber": "<x>1",
            "insured": true
        }))
        .unwrap();
        let html = business.block_html();
        assert!(!html.contains("<b>") && !html.contains("<x>"), "{html}");
        assert!(html.contains("Licensed and insured"));
    }

    #[test]
    fn only_stated_fields_reach_the_structured_data() {
        let business =
            BusinessConfig::from_value(&json!({"displayName": "Acme", "trade": "plumbing"}))
                .unwrap();
        let ld =
            business.local_business_json_ld("https://e.dev/#business", "https://e.dev/", "Blog");
        assert_eq!(
            ld,
            json!({
                "@context": "https://schema.org",
                "@type": "Plumber",
                "@id": "https://e.dev/#business",
                "name": "Acme",
                "url": "https://e.dev/"
            })
        );
    }

    #[test]
    fn every_bundled_trade_maps_to_a_schema_type() {
        for trade in crate::job::TRADES {
            assert_ne!(schema_type_for_trade(trade), "", "{trade}");
        }
        assert_eq!(schema_type_for_trade("other"), "LocalBusiness");
        assert_eq!(schema_type_for_trade("made-up"), "LocalBusiness");
    }
}
