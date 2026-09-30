//! `MAJOR.MINOR.PATCH` versions; a pre-release suffix (`-beta.1`) sorts before the release.
//! Versions name the files of the updates folder: a pre-release holds only `[0-9A-Za-z-]`
//! identifiers separated by dots, so no version can carry a path separator or `..`.

use std::cmp::Ordering;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre_release: Option<String>,
}

impl Version {
    /// Accepts `0.3.0`, `v0.3.0`, `0.3.0-beta.1`; anything else is `None`.
    pub fn parse(text: &str) -> Option<Self> {
        let text: &str = text.trim().strip_prefix('v').unwrap_or(text.trim());
        let (core, pre_release) = match text.split_once('-') {
            Some((core, pre)) if valid_pre_release(pre) => (core, Some(pre.to_owned())),
            Some(_) => return None,
            None => (text, None),
        };
        let mut parts = core.split('.');
        let mut number = || -> Option<u64> {
            let part: &str = parts.next()?;
            (!part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) && part.len() <= 9)
                .then(|| part.parse().ok())?
        };
        let version = Self { major: number()?, minor: number()?, patch: number()?, pre_release };
        parts.next().is_none().then_some(version)
    }
}

/// SemVer's rule: dot-separated, non-empty identifiers of ASCII letters, digits and hyphens.
fn valid_pre_release(pre: &str) -> bool {
    pre.len() <= 64
        && pre
            .split('.')
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// SemVer precedence: identifier by identifier, numbers numerically and before words, and a
/// shorter list first when all shared identifiers are equal (`beta.9 < beta.10 < beta.10.1`).
fn compare_pre_release(a: &str, b: &str) -> Ordering {
    let numeric =
        |id: &str| -> Option<u64> { id.bytes().all(|b| b.is_ascii_digit()).then(|| id.parse().ok())? };
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (numeric(x), numeric(y)) {
                    (Some(m), Some(n)) => m.cmp(&n),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(
            || match (&self.pre_release, &other.pre_release) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => compare_pre_release(a, b),
            },
        )
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre_release {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    #[test]
    fn compares_numerically_not_as_text() {
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("1.0.0") > v("0.99.99"));
        assert!(v("0.3.0") > v("0.2.12"));
        assert_eq!(v("v0.3.0"), v("0.3.0"));
    }

    #[test]
    fn a_pre_release_comes_before_its_release() {
        assert!(v("0.3.0") > v("0.3.0-beta.2"));
        assert!(v("0.3.0-beta.2") > v("0.2.9"));
        assert!(v("0.3.0-beta.2") > v("0.3.0-beta.1"));
    }

    #[test]
    fn pre_releases_follow_semver_precedence() {
        assert!(v("0.3.0-beta.10") > v("0.3.0-beta.9"));
        assert!(v("0.3.0-beta.10.1") > v("0.3.0-beta.10"));
        assert!(v("0.3.0-rc.1") > v("0.3.0-beta.10"));
        assert!(v("0.3.0-beta") > v("0.3.0-2"), "a word comes after a number");
        assert_eq!(v("0.3.0-beta.1").cmp(&v("0.3.0-beta.1")), Ordering::Equal);
    }

    #[test]
    fn a_pre_release_cannot_carry_a_path() {
        for bad in [
            "0.3.0-a/../x",
            r"0.3.0-a\b",
            "0.3.0-a:b",
            "0.3.0-a b",
            "0.3.0-a..b",
            "0.3.0-.a",
            "0.3.0-a.",
            "0.3.0-é",
        ] {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
        assert!(Version::parse("0.3.0-rc-1.2").is_some());
    }

    #[test]
    fn junk_is_refused() {
        for bad in ["", "0.3", "0.3.0.1", "a.b.c", "0.3.-1", "0.3.0-", " 1 .2.3", "1.2.3x", "9999999999.0.0"]
        {
            assert_eq!(Version::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn displays_without_the_v() {
        assert_eq!(v("v1.2.3-rc.1").to_string(), "1.2.3-rc.1");
    }
}
