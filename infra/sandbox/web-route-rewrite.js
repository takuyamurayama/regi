/* exported handler */
function handler(event) {
  var request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return request;
  var uri = request.uri.replace(/\/$/, '') || '/';
  var pages = [
    '/',
    '/dashboard',
    '/products',
    '/purchases/orders',
    '/inventory',
    '/sales',
    '/shifts',
    '/ai',
    '/sync',
    '/settings',
    '/purchases/invoices',
    '/purchases/payables',
    '/purchases/returns',
    '/purchases/suppliers',
  ];
  var invoice =
    /^\/purchases\/invoices\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (pages.indexOf(uri) !== -1 || invoice.test(uri)) request.uri = '/index.html';
  return request;
}
