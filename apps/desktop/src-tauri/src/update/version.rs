//! `MAJOR.MINOR.PATCH` versions; a pre-release suffix (`-beta.1`) sorts before the release.

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
            Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_owned())),
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

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(
            || match (&self.pre_release, &other.pre_release) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
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
