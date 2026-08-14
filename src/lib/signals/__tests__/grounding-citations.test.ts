import { resolveGroundingCitationIdentities } from '../grounding-citations';

function redirectResponse(location: string, status = 302): Response {
  return { status, headers: new Headers({ location }) } as Response;
}

describe('resolveGroundingCitationIdentities', () => {
  it('does not fetch direct publisher citations', async () => {
    const fetchImpl = jest.fn();
    const citations = [{ uri: 'https://publisher.example/report', title: 'Publisher' }];

    await expect(resolveGroundingCitationIdentities(citations, { fetchImpl })).resolves.toEqual(citations);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // AI-048 — resolution moved into `generateGroundedContent`, so a caller that
  // also resolves (or re-resolves a stored citation set) must not pay a second
  // round-trip. `uri` deliberately stays the redirect, so already-resolved
  // citations are recognised by `identityUri`, not by the uri shape.
  it('is idempotent — an already-resolved citation is not re-fetched', async () => {
    const fetchImpl = jest.fn();
    const citations = [
      {
        uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token',
        identityUri: 'https://publisher.example/article',
      },
    ];

    await expect(resolveGroundingCitationIdentities(citations, { fetchImpl })).resolves.toEqual(citations);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still resolves unresolved citations alongside already-resolved ones', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(redirectResponse('https://publisher.example/second'));
    const resolved = {
      uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/one',
      identityUri: 'https://publisher.example/first',
    };
    const pending = { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/two' };

    await expect(resolveGroundingCitationIdentities([resolved, pending], { fetchImpl })).resolves.toEqual([
      resolved,
      { ...pending, identityUri: 'https://publisher.example/second' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('recovers a publisher identity without following the publisher redirect', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(redirectResponse('https://publisher.example/Report?utm_source=google'));
    const redirectUri = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque-token';

    await expect(
      resolveGroundingCitationIdentities([{ uri: redirectUri, title: 'publisher.example' }], { fetchImpl })
    ).resolves.toEqual([
      {
        uri: redirectUri,
        title: 'publisher.example',
        identityUri: 'https://publisher.example/Report?utm_source=google',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(redirectUri),
      expect.objectContaining({ method: 'GET', redirect: 'manual', cache: 'no-store' })
    );
  });

  it('allows one additional trusted Google redirect hop', async () => {
    const first = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/first';
    const second = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/second';
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(redirectResponse(second))
      .mockResolvedValueOnce(redirectResponse('https://publisher.example/article'));

    await expect(resolveGroundingCitationIdentities([{ uri: first }], { fetchImpl })).resolves.toEqual([
      { uri: first, identityUri: 'https://publisher.example/article' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a non-redirect response', { status: 200, headers: new Headers() } as Response],
    ['a non-HTTP destination', redirectResponse('file:///etc/passwd')],
  ])('fails closed for %s', async (_label, response) => {
    const citation = {
      uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token',
    };
    const fetchImpl = jest.fn().mockResolvedValue(response);

    await expect(resolveGroundingCitationIdentities([citation], { fetchImpl })).resolves.toEqual([citation]);
  });

  it('fails closed when the trusted endpoint cannot be reached', async () => {
    const citation = {
      uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/token',
    };
    const fetchImpl = jest.fn().mockRejectedValue(new Error('offline'));

    await expect(resolveGroundingCitationIdentities([citation], { fetchImpl })).resolves.toEqual([citation]);
  });
});
