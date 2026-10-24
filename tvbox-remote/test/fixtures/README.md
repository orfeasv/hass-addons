Test-only certificates, self-signed for `.test` names (reserved, never real) and trusted nowhere:

- `tls-cert.pem` and `tls-key.pem`: names `tvbox.example.test` and `*.lan.example.test`
- `tls-cert-no-names.pem`: no subject alternative names

Made with `openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=…" -addext "subjectAltName=…"`.
