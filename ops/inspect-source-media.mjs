/**
 * Read-only, credential-free diagnostic for the source-media stage of Issue #58.
 * Only requests public Qiita API or Zenn RSS; never reads D1 or Discord webhooks.
 * Do not output queries, article titles, raw image URLs, tokens or RSS bodies.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchQiita } from '../src/sources/qiita.ts';
import { zennFeedUrl, parseZenn } from '../src/sources/zenn.ts';
import { fetchTextBounded, entries } from '../src/sources/xml.ts';
import { persistentMedia } from '../src/persisted-media.ts';

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return {help:true};
  let source=null, query=null;
  for (const arg of argv) {
    if (arg.startsWith('--source=') && source === null &&
        ['qiita','zenn'].includes(arg.slice('--source='.length))) {
      source=arg.slice('--source='.length);
    } else if (arg.startsWith('--query=') && query === null) {
      query=arg.slice('--query='.length).trim();
    } else {
      throw new Error('Invalid or duplicate option');
    }
  }
  if (!source || !query || query.length > 200 || /[\x00-\x1f\x7f]/.test(query))
    throw new Error('Expected --source=qiita|zenn and a valid --query');
  // Fail closed before fetching; a Zenn query only permits user/topic feeds.
  if (source === 'zenn') zennFeedUrl(query);
  return {help:false,source,query};
}

function hasStructuralEnclosure(xml) {
  const structure=xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g,'');
  return /<enclosure\b[^>]{0,4096}>/i.test(structure);
}

/** The output contains only aggregate counts and booleans. It does not
 * infer production D1 status or assert the Discord client displayed media.
 */
export async function inspectSourceMedia(source,query,fetcher=fetch) {
  const options=parseOptions(['--source='+source,'--query='+query]);
  let items, potentiallyTruncated, enclosureTags=null;
  if (options.source === 'zenn') {
    const xml=await fetchTextBounded(zennFeedUrl(options.query),'Zenn',fetcher);
    const rawEntries=entries(xml,'item');
    items=parseZenn(xml);
    enclosureTags=rawEntries.filter(hasStructuralEnclosure).length;
    potentiallyTruncated=items.length >= 20;
  } else {
    const monitor={id:'read-only-media-inspection',source:'qiita',query:options.query,
      enabled:true,intervalMinutes:60};
    const feed=await fetchQiita(monitor,fetcher);
    items=feed.items;
    potentiallyTruncated=feed.potentiallyTruncated || feed.nextCursor != null;
  }
  let withImage=0,persistableImage=0,withThumbnail=0,persistableThumbnail=0;
  for (const item of items) {
    const media=persistentMedia(options.source,item);
    if (item.imageUrl) {
      withImage++;
      if (media.imageUrl) persistableImage++;
    }
    if (item.thumbnailUrl) {
      withThumbnail++;
      if (media.thumbnailUrl) persistableThumbnail++;
    }
  }
  return {
    ok:true,source:options.source,items:items.length,potentiallyTruncated,
    ...(options.source === 'zenn' ? {entriesWithEnclosureTag:enclosureTags} : {}),
    imageUrlsParsed:withImage,imageUrlsPersistable:persistableImage,
    imageUrlsRejectedForPersistence:withImage-persistableImage,
    thumbnailUrlsParsed:withThumbnail,thumbnailUrlsPersistable:persistableThumbnail,
    thumbnailUrlsRejectedForPersistence:withThumbnail-persistableThumbnail,
    // For Zenn this is the number of enclosure tags that failed URL parsing /
    // extraction (not a claim that their source URLs were image files).
    ...(options.source === 'zenn' ? {enclosuresWithoutParsedImage:enclosureTags-withImage} : {}),
  };
}

async function main() {
  const opts=parseOptions(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: npm run inspect:source-media -- --source=qiita --query=tag:Rust');
    console.log('   or: npm run inspect:source-media -- --source=zenn --query=topic:typescript');
    console.log('One read-only public upstream request. No D1, Discord or private keys.');
    return;
  }
  console.log(JSON.stringify(await inspectSourceMedia(opts.source,opts.query),null,2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch { console.error(JSON.stringify({ok:false,message:'Source inspection failed; check network and source query'}));
    process.exitCode=1; }
}
