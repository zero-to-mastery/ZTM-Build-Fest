//! Shared outbound HTTP policy that resolves only public network addresses.

use std::fmt;
use std::net::{IpAddr, SocketAddr};

use ureq::config::Config;
use ureq::unversioned::resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{Connector, NextTimeout, RustlsConnector, TcpConnector};

#[derive(Clone, Default)]
pub(crate) struct PublicResolver {
    test_mapping: Option<(String, SocketAddr)>,
    allow_non_public_test_mapping: bool,
}

impl fmt::Debug for PublicResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("PublicResolver").finish()
    }
}

impl Resolver for PublicResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let addresses = if let Some((host, address)) = &self.test_mapping {
            if uri.host() == Some(host.as_str()) {
                let mut addresses = self.empty();
                addresses.push(*address);
                addresses
            } else {
                DefaultResolver::default().resolve(uri, config, timeout)?
            }
        } else {
            DefaultResolver::default().resolve(uri, config, timeout)?
        };
        if !self.allow_non_public_test_mapping
            && addresses.iter().any(|address| !is_public_ip(address.ip()))
        {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(addresses)
    }
}

impl PublicResolver {
    #[cfg(test)]
    pub(crate) fn mapped_for_policy_test(host: &str, address: SocketAddr) -> Self {
        Self {
            test_mapping: Some((host.into(), address)),
            allow_non_public_test_mapping: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn mapped_for_local_test(host: &str, address: SocketAddr) -> Self {
        Self {
            test_mapping: Some((host.into(), address)),
            allow_non_public_test_mapping: true,
        }
    }
}

pub(crate) fn public_agent(config: Config, resolver: PublicResolver) -> ureq::Agent {
    let connector = ().chain(TcpConnector::default()).chain(RustlsConnector::default());
    ureq::Agent::with_parts(config, connector, resolver)
}

pub(crate) fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(address) => {
            let octets = address.octets();
            let segments = address.segments();
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let reserved = octets[0..4] == [0x20, 0x01, 0x0d, 0xb8]
                || (segments[0] == 0x2001 && segments[1] == 0)
                || (segments[0] == 0x2001 && segments[1] == 2)
                || (segments[0] == 0x2001 && (0x10..=0x2f).contains(&segments[1]))
                || segments[0] == 0x2002
                || (segments[0] & 0xfff0) == 0x3ff0;
            (octets[0] & 0xe0) == 0x20 && !reserved
        }
    }
}
