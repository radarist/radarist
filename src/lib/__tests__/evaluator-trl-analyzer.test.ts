import { analyzeTrlDefensibility } from '../mission-quality/analyzers/evaluator-trl-analyzer';

describe('analyzeTrlDefensibility', () => {
  it('passes when there are no TRL ≥ 5 claims at all', () => {
    const verdict = analyzeTrlDefensibility('We ran a lab benchmark. The tool is promising.');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claimCount).toBe(0);
  });

  it('passes when only low-TRL claims (1–4) are made', () => {
    const verdict = analyzeTrlDefensibility(
      'Our assessment is TRL 3 — principles observed, a proof of concept is running in the lab.'
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claimCount).toBe(0);
  });

  it('fails when a TRL ≥ 5 claim has no deployment evidence in its window', () => {
    const verdict = analyzeTrlDefensibility(
      'Based on a close read of the vendor collateral and the GitHub repo, we assess this technology at TRL 7. The market is expanding rapidly and interest is growing.'
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.unsupported).toHaveLength(1);
      expect(verdict.unsupported[0].trlLevel).toBe(7);
    }
  });

  it('passes when a TRL ≥ 5 claim is accompanied by deployment evidence in the same paragraph', () => {
    const verdict = analyzeTrlDefensibility(
      'We assess this at TRL 7 — the vendor has a reference deployment at Acme Corp running in production since 2024 with 4 customer sites.'
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claimCount).toBe(1);
  });

  it('fails when the deployment word is outside the ±1500 char window', () => {
    const text2 =
      'Deployed in production. ' +
      'x'.repeat(3000) +
      ' We assess this at TRL 7 with strong maturity and no other evidence here.';
    const verdict = analyzeTrlDefensibility(text2);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.unsupported[0].trlLevel).toBe(7);
  });

  it('reports only the unsupported claim when mixed claims are present', () => {
    const text =
      'Technology A is TRL 7 — it is deployed in production at 3 reference customer sites.\n\n' +
      'x'.repeat(3000) +
      '\n\nTechnology B is TRL 6. We found no evidence of operational deployment here.';
    const verdict = analyzeTrlDefensibility(text);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.unsupported).toHaveLength(1);
      expect(verdict.unsupported[0].trlLevel).toBe(6);
    }
  });

  it('passes on long structured reports where deployment evidence is within the ±1500 window', () => {
    // Mirrors the live Kubernetes TRL mission pattern: TRL claim in a
    // scoring section, deployment markers in nearby methodology prose.
    // Previously (500-char window) this failed — evidence was ~800 chars
    // away. With 1500-char default the evidence is inside the window.
    const claim = 'Evidence supports TRL 9 placement on the Technology Readiness scale.';
    const methodology =
      'Sources were drawn from vendor case studies and third-party audits. ' +
      'Observed production deployments include GKE, EKS, AKS at scale, with ' +
      'reference customer installs at 5000+ nodes. Operated in service across ' +
      '82% of Fortune 500 container shops. The scoring methodology drew on ' +
      'the NASA-adapted software TRL ladder with each gate requiring named ' +
      'operational evidence.';
    const text = claim + 'x'.repeat(800) + methodology;
    const verdict = analyzeTrlDefensibility(text);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claimCount).toBe(1);
  });

  it('matches TRL claims case-insensitively and with varied spacing/colon', () => {
    const text = 'After analysis our verdict is trl: 8. The system has been rolled out across 12 deployments.';
    const verdict = analyzeTrlDefensibility(text);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claimCount).toBe(1);
  });
});
