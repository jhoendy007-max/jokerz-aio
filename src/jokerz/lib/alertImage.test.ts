import test from 'node:test';
import assert from 'node:assert/strict';
import { safeImageUrl, discordImagePlacement, slackImageFields, normalizeStyle } from './alertImage.ts';

const U = 'https://i5.walmartimages.com/a.jpg';

test('safeImageUrl', () => {
  assert.equal(safeImageUrl(U), U);
  assert.equal(safeImageUrl('//cdn.x/a.png'), 'https://cdn.x/a.png');
  assert.equal(safeImageUrl('http://cdn.x/a.png'), 'https://cdn.x/a.png');
  assert.equal(safeImageUrl('data:image/png;base64,AAAA'), undefined);
  assert.equal(safeImageUrl('https://x/a".png'), undefined);
  assert.equal(safeImageUrl(undefined), undefined);
});

test('discord: big photo for stock/success/price, thumbnail for others', () => {
  assert.deepEqual(discordImagePlacement('stock', 'large', U), { image: { url: U } });
  assert.deepEqual(discordImagePlacement('success', 'large', U), { image: { url: U } });
  assert.deepEqual(discordImagePlacement('decline', 'large', U), { thumbnail: { url: U } });
  assert.deepEqual(discordImagePlacement('stock', 'thumbnail', U), { thumbnail: { url: U } });
  assert.deepEqual(discordImagePlacement('stock', 'off', U), {});
  assert.deepEqual(discordImagePlacement('stock', 'large', 'not a url'), {});
});

test('slack fields + style default', () => {
  assert.deepEqual(slackImageFields('large', U), { image_url: U });
  assert.deepEqual(slackImageFields('thumbnail', U), { thumb_url: U });
  assert.deepEqual(slackImageFields('off', U), {});
  assert.equal(normalizeStyle(undefined), 'large');
  assert.equal(normalizeStyle('off'), 'off');
});
