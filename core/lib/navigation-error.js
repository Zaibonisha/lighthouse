/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

import {LighthouseError} from './lh-error.js';
import {NetworkAnalyzer} from './dependency-graph/simulator/network-analyzer.js';
import {NetworkRequest} from './network-request.js';
import * as i18n from '../lib/i18n/i18n.js';

const UIStrings = {
  /**
   * Warning shown in report when the page under test is an XHTML document, which Lighthouse does not directly support
   * so we display a warning.
   */
  warningXhtml:
    'The page MIME type is XHTML: Lighthouse does not explicitly support this document type',
};

const str_ = i18n.createMessageInstanceIdFn(import.meta.url, UIStrings);

// MIME types are case-insensitive but Chrome normalizes MIME types to be lowercase.
const HTML_MIME_TYPE = 'text/html';
const XHTML_MIME_TYPE = 'application/xhtml+xml';

/**
 * Returns an error if the original network request failed or wasn't found.
 * @param {LH.Artifacts.NetworkRequest|undefined} mainRecord
 * @return {LH.LighthouseError|undefined}
 */
function getNetworkError(mainRecord) {
  if (!mainRecord) {
    return new LighthouseError(LighthouseError.errors.NO_DOCUMENT_REQUEST);
  } else if (mainRecord.failed) {
    const netErr = mainRecord.localizedFailDescription;
    // Match all resolution and DNS failures
    // https://cs.chromium.org/chromium/src/net/base/net_error_list.h?rcl=cd62979b
    if (
      netErr === 'net::ERR_NAME_NOT_RESOLVED' ||
      netErr === 'net::ERR_NAME_RESOLUTION_FAILED' ||
      netErr.startsWith('net::ERR_DNS_')
    ) {
      return new LighthouseError(LighthouseError.errors.DNS_FAILURE);
    } else {
      return new LighthouseError(
        LighthouseError.errors.FAILED_DOCUMENT_REQUEST, {errorDetails: netErr});
    }
  } else if (mainRecord.hasErrorStatusCode()) {
    return new LighthouseError(LighthouseError.errors.ERRORED_DOCUMENT_REQUEST, {
      statusCode: `${mainRecord.statusCode}`,
    });
  }
}

/**
 * Returns an error if we ended up on the `chrome-error` page and all other requests failed.
 * @param {LH.Artifacts.NetworkRequest|undefined} mainRecord
 * @param {Array<LH.Artifacts.NetworkRequest>} networkRecords
 * @return {LH.LighthouseError|undefined}
 */
function getInterstitialError(mainRecord, networkRecords) {
  // If we never requested a document, there's no interstitial error, let other cases handle it.
  if (!mainRecord) return undefined;

  const interstitialRequest = networkRecords.find(record =>
    record.documentURL.startsWith('chrome-error://')
  );
  // If the page didn't end up on a chrome interstitial, there's no error here.
  if (!interstitialRequest) return undefined;

  // If the main document didn't fail, we didn't end up on an interstitial.
  // FIXME: This doesn't handle client-side redirects.
  // None of our error-handling deals with this case either because passContext.url doesn't handle non-network redirects.
  if (!mainRecord.failed) return undefined;

  // If a request failed with the `net::ERR_CERT_*` collection of errors, then it's a security issue.
  if (mainRecord.localizedFailDescription.startsWith('net::ERR_CERT')) {
    return new LighthouseError(LighthouseError.errors.INSECURE_DOCUMENT_REQUEST, {
      securityMessages: mainRecord.localizedFailDescription,
    });
  }

  // If we made it this far, it's a generic Chrome interstitial error.
  return new LighthouseError(LighthouseError.errors.CHROME_INTERSTITIAL_ERROR);
}

/**
 * Returns an error if we try to load a non-HTML page.
 * Expects a network request with all redirects resolved, otherwise the MIME type may be incorrect.
 * @param {LH.Artifacts.NetworkRequest|undefined} finalRecord
 * @return {LH.LighthouseError|undefined}
 */
function getNonHtmlError(finalRecord) {
  // If we never requested a document, there's no doctype error, let other cases handle it.
  if (!finalRecord) return undefined;

  // mimeType is determined by the browser, we assume Chrome is determining mimeType correctly,
  // independently of 'Content-Type' response headers, and always sending mimeType if well-formed.
  if (finalRecord.mimeType !== HTML_MIME_TYPE && finalRecord.mimeType !== XHTML_MIME_TYPE) {
    return new LighthouseError(LighthouseError.errors.NOT_HTML, {
      mimeType: finalRecord.mimeType,
    });
  }

  return undefined;
}

/**
 * Returns an error if the page load should be considered failed, e.g. from a
 * main document request failure, a security issue, etc.
 * @param {LH.LighthouseError|undefined} navigationError
 * @param {{url: string, loadFailureMode: LH.Gatherer.PassContext['passConfig']['loadFailureMode'], networkRecords: Array<LH.Artifacts.NetworkRequest>, warnings: Array<string | LH.IcuMessage>}} context
 * @return {LH.LighthouseError|undefined}
 */
function getPageLoadError(navigationError, context) {
  const {url, loadFailureMode, networkRecords} = context;
  /** @type {LH.Artifacts.NetworkRequest|undefined} */
  let mainRecord = NetworkAnalyzer.findResourceForUrl(networkRecords, url);

  // If the url doesn't give us a network request, it's possible we landed on a chrome-error:// page
  // In this case, just get the first document request.
  if (!mainRecord) {
    const documentRequests = networkRecords.filter(record =>
      record.resourceType === NetworkRequest.TYPES.Document
    );
    if (documentRequests.length) {
      mainRecord = documentRequests.reduce((min, r) => (r.startTime < min.startTime ? r : min));
    }
  }

  // MIME Type is only set on the final redirected document request. Use this for the HTML check instead of root.
  let finalRecord;
  if (mainRecord) {
    finalRecord = NetworkAnalyzer.resolveRedirects(mainRecord);
  }

  if (finalRecord?.mimeType === XHTML_MIME_TYPE) {
    context.warnings.push(str_(UIStrings.warningXhtml));
  }

  const networkError = getNetworkError(mainRecord);
  const interstitialError = getInterstitialError(mainRecord, networkRecords);
  const nonHtmlError = getNonHtmlError(finalRecord);

  // Check to see if we need to ignore the page load failure.
  // e.g. When the driver is offline, the load will fail without page offline support.
  if (loadFailureMode === 'ignore') return;

  // We want to special-case the interstitial beyond FAILED_DOCUMENT_REQUEST. See https://github.com/GoogleChrome/lighthouse/pull/8865#issuecomment-497507618
  if (interstitialError) return interstitialError;

  // Network errors are usually the most specific and provide the best reason for why the page failed to load.
  // Prefer networkError over navigationError.
  // Example: `DNS_FAILURE` is better than `NO_FCP`.
  if (networkError) return networkError;

  // Error if page is not HTML.
  if (nonHtmlError) return nonHtmlError;

  // Navigation errors are rather generic and express some failure of the page to render properly.
  // Use `navigationError` as the last resort.
  // Example: `NO_FCP`, the page never painted content for some unknown reason.
  return navigationError;
}

export {
  getNetworkError,
  getInterstitialError,
  getPageLoadError,
  getNonHtmlError,
  UIStrings,
};
