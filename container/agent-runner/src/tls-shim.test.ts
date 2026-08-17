import { describe, it, expect } from 'bun:test';

import { applyTlsCertShim } from './tls-shim.js';

describe('applyTlsCertShim (AD-15)', () => {
  it('sets NODE_EXTRA_CA_CERTS from SSL_CERT_FILE when unset', () => {
    const env = { SSL_CERT_FILE: '/certs/gateway-ca.pem' } as NodeJS.ProcessEnv;
    applyTlsCertShim(env);
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/certs/gateway-ca.pem');
  });

  it('does not override an already-set NODE_EXTRA_CA_CERTS', () => {
    const env = {
      SSL_CERT_FILE: '/certs/gateway-ca.pem',
      NODE_EXTRA_CA_CERTS: '/certs/other.pem',
    } as NodeJS.ProcessEnv;
    applyTlsCertShim(env);
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/certs/other.pem');
  });

  it('is a no-op when SSL_CERT_FILE is unset', () => {
    const env = {} as NodeJS.ProcessEnv;
    applyTlsCertShim(env);
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('does not stringify "undefined" when SSL_CERT_FILE is unset (??= footgun)', () => {
    const env = { NODE_EXTRA_CA_CERTS: undefined } as NodeJS.ProcessEnv;
    applyTlsCertShim(env);
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it('defaults to process.env when no env is passed', () => {
    const prevSsl = process.env.SSL_CERT_FILE;
    const prevExtra = process.env.NODE_EXTRA_CA_CERTS;
    delete process.env.NODE_EXTRA_CA_CERTS;
    process.env.SSL_CERT_FILE = '/certs/gateway-ca.pem';
    try {
      applyTlsCertShim();
      expect(process.env.NODE_EXTRA_CA_CERTS).toBe('/certs/gateway-ca.pem');
    } finally {
      if (prevSsl === undefined) delete process.env.SSL_CERT_FILE;
      else process.env.SSL_CERT_FILE = prevSsl;
      if (prevExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = prevExtra;
    }
  });
});
