import { describe, expect, it } from 'bun:test';
import { imageRows } from '../commands/list/images';

const images = ['shop-web-production\t1.4.2\t120MB\t2 days ago', 'shop-web-production\t1.4.1\t118MB\t5 days ago', 'postgres\t16\t400MB\t3 weeks ago'].join('\n');

describe('imageRows', () => {
  it('keeps the project images and marks the ones a running container uses', () => {
    expect(imageRows(images, 'shop-web-production:1.4.2\n', 'shop', false)).toEqual([
      { repository: 'shop-web-production', tag: '1.4.2', size: '120MB', created: '2 days ago', inUse: true },
      { repository: 'shop-web-production', tag: '1.4.1', size: '118MB', created: '5 days ago', inUse: false },
    ]);
  });

  it('lists every image with --all, and never matches the project name as a pattern', () => {
    expect(imageRows(images, '', 'shop', true)).toHaveLength(3);
    expect(imageRows(images, '', '.*', false)).toEqual([]);
  });
});
