#!/usr/bin/env bash
# A Samba Active Directory domain controller for test/ad.it.test.ts:
#   bash test/it/ad.sh && QUERIER_IT_AD=ldaps://localhost:10636 QUERIER_IT_AD_CA=/tmp/querier-ad-ca.pem bun test test/ad.it.test.ts
set -e
docker rm -f qad >/dev/null 2>&1 || true
docker run -d --name qad --hostname dc1 --privileged -p 10636:636 -e REALM=CORP.EXAMPLE.COM -e DOMAIN=CORP -e ADMIN_PASS='Adm1n-Passw0rd!' \
  -e DNS_FORWARDER=1.1.1.1 -e BIND_NETWORK_INTERFACES=false diegogslomp/samba-ad-dc >/dev/null
for i in $(seq 1 60); do docker exec qad samba-tool domain info 127.0.0.1 >/dev/null 2>&1 && break; sleep 2; done
docker exec qad bash -c '
samba-tool user add svc-querier "Svc-Passw0rd!"
samba-tool user add ana "Ana-Passw0rd!" --given-name=Ana --surname=Lima --mail-address=ana@corp.example.com --department=Finance
samba-tool user add bob "Bob-Passw0rd!" --department=Sales
samba-tool user disable bob
samba-tool group add finance
samba-tool group add finance-analysts
samba-tool group addmembers finance finance-analysts
samba-tool group addmembers finance-analysts ana' >/dev/null
docker cp qad:/usr/local/samba/private/tls/ca.pem /tmp/querier-ad-ca.pem
echo "AD ready: ldaps://localhost:10636, CA in /tmp/querier-ad-ca.pem"
