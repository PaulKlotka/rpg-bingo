const pages = { game: 'Game', room: 'Shared Room', instructions: 'Instructions', rewards: 'Rewards', history: 'Round History' };
export type Page = keyof typeof pages;

export function showPage(page: Page) {
  if (location.hash !== `#${page}`) location.hash = page;
  else updatePage();
}

function updatePage() {
  const key = location.hash.slice(1);
  const page: Page = Object.hasOwn(pages, key) ? key as Page : 'game';
  document.body.dataset.page = page;
  document.querySelectorAll<HTMLAnchorElement>('[data-page-link]').forEach(link => {
    if (link.dataset.pageLink === page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('#current-page')!.textContent = pages[page];
  document.querySelector<HTMLDetailsElement>('#page-menu')!.open = false;
  window.scrollTo({ top: 0 });
}

export function mountNavigation() {
  window.addEventListener('hashchange', updatePage);
  document.querySelectorAll<HTMLAnchorElement>('[data-page-link]').forEach(link => {
    link.addEventListener('click', event => {
      event.preventDefault();
      showPage(link.dataset.pageLink as Page);
    });
  });
  document.querySelector('#page-menu')!.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Escape') document.querySelector<HTMLDetailsElement>('#page-menu')!.open = false;
  });
  updatePage();
}
