import * as urlParser from 'url';
import {
  migrateChildren,
  getMediaBase,
  getFullUrl,
  getRelativeFilePath,
  encodeArticleIdForZimHtmlUrl,
} from './misc';
import { articleDetailXId, redirectsXId } from '../stores';
import { Dump } from '../Dump';
import MediaWiki from '../MediaWiki';
import DU from '../DOMUtils';
import logger from '../Logger';

function rewriteUrlNoArticleCheck(
  articleId: string,
  mw: MediaWiki,
  dump: Dump,
  linkNode: DominoElement,
  mediaDependencies?: string[],
): string {
  let rel = linkNode.getAttribute('rel');
  let href = linkNode.getAttribute('href') || '';
  let hrefProtocol;

  try {
    hrefProtocol = urlParser.parse(href).protocol;
  } catch(e) {
    return null;
  }
  if (hrefProtocol && !hrefProtocol.includes('http')) {
    // e.g. geo:11111,11111
    return null;
  }
  if (rel === 'mwo:NoRewrite') {
    return null;
  }
  if (!hrefProtocol && href.slice(0, 2) === '//') {
    href = `${mw.webUrl.protocol}${href}`;
    linkNode.setAttribute('href', href);
    hrefProtocol = mw.webUrl.protocol;
  }
  if (!rel && linkNode.getAttribute('resource')) {
    rel = 'mw:MediaLink';
  }
  if (hrefProtocol && hrefProtocol.includes('http') && !rel) {
    rel = 'mw:ExtLink';
  }
  if (!href) {
    DU.deleteNode(linkNode);
    return null;
  }
  if (href.substring(0, 1) === '#') {
    return null;
  }

  /* Deal with custom geo. URL replacement, for example:
   * http://maps.wikivoyage-ev.org/w/poimap2.php?lat=44.5044943&lon=34.1969633&zoom=15&layer=M&lang=ru&name=%D0%9C%D0%B0%D1%81%D1%81%D0%B0%D0%BD%D0%B4%D1%80%D0%B0
   * http://tools.wmflabs.org/geohack/geohack.php?language=fr&pagename=Tour_Eiffel&params=48.85825_N_2.2945_E_type:landmark_region:fr
   */
  if (rel !== 'mw:WikiLink') {
    let lat;
    let lon;
    if (/poimap2\.php/i.test(href)) {
      const hrefQuery = urlParser.parse(href, true).query;
      lat = parseFloat(hrefQuery.lat as string);
      lon = parseFloat(hrefQuery.lon as string);
    } else if (/geohack\.php/i.test(href)) {
      let { params } = urlParser.parse(href, true).query;

      // "params" might be an array, try to detect the geo localization one
      if (params instanceof Array) {
        let i = 0;
        while (params[i] && isNaN(+params[i][0])) {
          i += 1;
        }
        params = params[i];
      }

      if (params) {
        // see https://bitbucket.org/magnusmanske/geohack/src public_html geo_param.php
        const pieces = params.toUpperCase().split('_');
        const semiPieces = pieces.length > 0
          ? pieces[0].split(';')
          : undefined;
        if (semiPieces && semiPieces.length === 2) {
          [lat, lon] = semiPieces;
        } else {
          const factors = [1, 60, 3600];
          let offs = 0;

          const deg = (hemiHash: any) => {
            let out = 0;
            let hemiSign = 0;
            for (let i = 0; i < 4 && i + offs < pieces.length; i += 1) {
              const v = pieces[i + offs];
              hemiSign = hemiHash[v];
              if (hemiSign) {
                offs = i + 1;
                break;
              }
              out += +v / factors[i];
            }
            return out * hemiSign;
          };
          lat = deg({ N: 1, S: -1 });
          lon = deg({ E: 1, W: -1, O: 1 });
        }
      }
    } else if (/Special:Map/i.test(href)) {
      const parts = href.split('/');
      lat = parts[4];
      lon = parts[5];
    } else if (rel === 'mw:MediaLink') {
      const shouldScrape = href.includes('.pdf') && !dump.nopdf ||
        href.includes('.ogg') && !dump.nopic && !dump.novid && !dump.nodet;

      if (shouldScrape) {
        try {
          const newHref = getRelativeFilePath(
            articleId,
            getMediaBase(href, true),
            'I',
          );
          linkNode.setAttribute('href', newHref);
          if (mediaDependencies) {
            mediaDependencies.push(href);
          }
        } catch (err) {
          logger.warn('Error parsing url:', err);
          DU.deleteNode(linkNode);
        }
      }
      return null;
    }

    if (!isNaN(lat) && !isNaN(lon)) {
      href = `geo:${lat},${lon}`;
      linkNode.setAttribute('href', href);
      return null;
    }
  }

  if (rel) {
    // This is Parsoid HTML

    /* Add 'external' class to interwiki links */
    if (rel.substring(0, 10) === 'mw:ExtLink'
      || rel === 'mw:WikiLink/Interwiki'
    ) {
      DU.appendToAttr(linkNode, 'class', 'external');
    }
    /* Rewrite external links starting with // */
    if (rel.substring(0, 10) === 'mw:ExtLink' || rel === 'nofollow') {
      if (href.substring(0, 1) === '/') {
        linkNode.setAttribute('href', getFullUrl(href, mw.baseUrl));
      } else if (href.substring(0, 2) === './') {
        migrateChildren(linkNode, linkNode.parentNode, linkNode);
        linkNode.parentNode.removeChild(linkNode);
      }
      return null;
    }
    if (rel !== 'mw:WikiLink' && rel !== 'mw:referencedBy') {
      return null;
    }
  }

  const title = mw.extractPageTitleFromHref(href);
  if (title) {
    const localAnchor = href.lastIndexOf('#') === -1
      ? ''
      : href.substr(href.lastIndexOf('#'));
    linkNode.setAttribute(
      'href',
      encodeArticleIdForZimHtmlUrl(title) + localAnchor,
    );
    return title;
  }

  return null;
}

async function checkIfArticlesMirrored(
  articleTitles: string[],
): Promise<[string[], string[]]> {
  const mirrored: string[] = [];
  const unmirrored: string[] = [];
  if (!articleTitles.length) {
    return [mirrored, unmirrored];
  }

  const articlesMirrored = await articleDetailXId.exists(articleTitles) as { [key: string]: number };
  for (const articleTitle of articleTitles) {
    if (articlesMirrored[articleTitle]) {
      mirrored.push(articleTitle);
    } else {
      unmirrored.push(articleTitle);
    }
  }
  return [mirrored, unmirrored];
}

async function rewriteUrls(
  articleId: string,
  mw: MediaWiki,
  dump: Dump,
  linkNodes: DominoElement[],
): Promise<{ mediaDependencies: string[] }>{
  const mediaDependencies: string[] = [];

  /*
   * key: article title
   * value: Array of linkNodes linking to article
   */
  const wikilinkMappings: { [title: string]: DominoElement[] } = {};

  for (const linkNode of linkNodes) {
    const articleLink = rewriteUrlNoArticleCheck(
      articleId,
      mw,
      dump,
      linkNode,
      mediaDependencies,
    );

    if (articleLink) {
      const nodeArray = wikilinkMappings[articleLink];
      if (nodeArray) {
        nodeArray.push(linkNode);
      } else {
        wikilinkMappings[articleLink] = [linkNode];
      }
    }
  };

  const [
    mirroredTitles,
    unmirroredTitles,
  ] = await checkIfArticlesMirrored(Object.keys(wikilinkMappings));

  if (unmirroredTitles.length) {
    const articlesRedirected = await redirectsXId.exists(unmirroredTitles) as { [key: string]: number; };
    for (const articleTitle of unmirroredTitles) {
      const redirect = articlesRedirected[articleTitle];
      if (redirect) {
        const href = encodeArticleIdForZimHtmlUrl(articleTitle);
        wikilinkMappings[articleTitle].forEach((linkNode: DominoElement) => {
          linkNode.setAttribute('href', href);
        });
      } else {
        wikilinkMappings[articleTitle].forEach((linkNode: DominoElement) => {
          migrateChildren(linkNode, linkNode.parentNode, linkNode);
          linkNode.parentNode.removeChild(linkNode);
        });
        delete wikilinkMappings[articleTitle];
      }
    };
  }

  if (articleId.includes('/')) {
    const resourceNamespace = 'A';
    const slashesInUrl = articleId.split('/').length - 1;
    const upStr = '../'.repeat(slashesInUrl + 1);
    Object.values(wikilinkMappings).forEach((linkNodes: DominoElement[]) => {
      for (const linkNode of linkNodes) {
        const href = linkNode.getAttribute('href');
        linkNode.setAttribute('href', `${upStr}${resourceNamespace}/${href}`);
      };
    });
  }

  return { mediaDependencies };
}

export function rewriteUrl(
  articleId: string,
  mw: MediaWiki,
  dump: Dump,
  linkNode: DominoElement,
): Promise<{ mediaDependencies: string[] }>{
  return rewriteUrls(
    articleId,
    mw,
    dump,
    [linkNode],
  );
}

export async function rewriteUrlsOfDoc(
  parsoidDoc: DominoElement,
  articleId: string,
  mw: MediaWiki,
  dump: Dump,
): Promise<{ mediaDependencies: string[], doc: DominoElement}> {
  const mediaDependencies: string[] = [];

  /* Go through all links */
  const as = parsoidDoc.getElementsByTagName('a');
  const areas = parsoidDoc.getElementsByTagName('area');
  const linkNodes: DominoElement[] = Array.prototype.slice.call(as)
    .concat(Array.prototype.slice.call(areas));

  const ret = await rewriteUrls(articleId, mw, dump, linkNodes);
  return {
    ...ret,
    doc: parsoidDoc,
  };
}
