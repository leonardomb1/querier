#!/usr/bin/env bash
# A Keycloak for test/keycloak.it.test.ts:
#   bash test/it/keycloak.sh && QUERIER_IT_KEYCLOAK=http://localhost:18080 bun test test/keycloak.it.test.ts
docker rm -f qkc >/dev/null 2>&1
docker run -d --name qkc -p 18080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak:26.4 start-dev >/dev/null
for i in $(seq 1 90); do curl -sf localhost:18080/realms/master >/dev/null && break; sleep 2; done
set -e
KC=http://localhost:18080
T=$(curl -s -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" $KC/realms/master/protocol/openid-connect/token | python3 -c "import json,sys;print(json.load(sys.stdin)['access_token'])")
H="Authorization: Bearer $T"
j() { curl -s -o /dev/null -w "%{http_code} $1\n" -H "$H" -H "content-type: application/json" -X "$2" "$KC/admin/realms$3" ${4:+-d "$4"}; }
j realm POST "" '{"realm":"querier","enabled":true,"attributes":{"userProfileEnabled":"false"}}'
# let users carry unmanaged attributes (department)
j profile PUT "/querier/users/profile" '{"attributes":[{"name":"username"},{"name":"email"},{"name":"firstName"},{"name":"lastName"}],"unmanagedAttributePolicy":"ENABLED"}'
j client POST "/querier/clients" '{"clientId":"querier","enabled":true,"publicClient":false,"secret":"s3cret","standardFlowEnabled":true,"redirectUris":["http://localhost:3999/api/auth/oidc/kc/callback"],"attributes":{"pkce.code.challenge.method":"S256"},"protocolMappers":[{"name":"groups","protocol":"openid-connect","protocolMapper":"oidc-group-membership-mapper","config":{"claim.name":"groups","full.path":"false","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true"}},{"name":"department","protocol":"openid-connect","protocolMapper":"oidc-usermodel-attribute-mapper","config":{"user.attribute":"department","claim.name":"department","id.token.claim":"true","access.token.claim":"true","userinfo.token.claim":"true","jsonType.label":"String","multivalued":"true"}}]}'
j group POST "/querier/groups" '{"name":"finance"}'
j user POST "/querier/users" '{"username":"ana","enabled":true,"email":"ana@example.com","emailVerified":true,"firstName":"Ana","lastName":"Lima","attributes":{"department":["Finance"]},"credentials":[{"type":"password","value":"ana-pass","temporary":false}]}'
UID_=$(curl -s -H "$H" "$KC/admin/realms/querier/users?username=ana" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
GID=$(curl -s -H "$H" "$KC/admin/realms/querier/groups?search=finance" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
j membership PUT "/querier/users/$UID_/groups/$GID"
