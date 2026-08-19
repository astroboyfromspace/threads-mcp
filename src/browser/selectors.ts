/**
 * Все зацепки за вёрстку Threads собраны здесь.
 *
 * Threads не даёт стабильных data-атрибутов, а классы генерируются сборщиком и
 * меняются от релиза к релизу. Поэтому опора — на роли и подписи доступности:
 * они меняются реже разметки. Когда Threads всё же переедет, чинить придётся
 * только этот файл.
 *
 * Подписи дублируются на русском и английском: язык интерфейса зависит от
 * настроек аккаунта, и завязываться на один язык — гарантированная поломка.
 */

export const URLS = {
  home: "https://www.threads.net/",
  login: "https://www.threads.net/login",
  profile: (username: string) => `https://www.threads.net/@${username.replace(/^@/, "")}`,
  post: (username: string, shortcode: string) =>
    `https://www.threads.net/@${username.replace(/^@/, "")}/post/${shortcode}`,
} as const;

/**
 * Кнопки, различающиеся текущим состоянием: подпись меняется после нажатия.
 *
 * Подписи закреплены только слева. Доступное имя кнопки склеивается из
 * aria-label иконки и счётчика рядом, поэтому у поста с лайками имя выглядит
 * как «Unlike 1», и закреплённое справа `$` перестаёт совпадать — молча, ровно
 * с того момента, как под постом появился первый лайк. Начало при этом
 * различает состояния: «like» не совпадает с «Unlike», «репост» — с «удалить
 * репост».
 */
export const BUTTON_LABELS = {
  like: [/^нравится/i, /^like/i],
  unlike: [/^не нравится/i, /^unlike/i],
  follow: [/^подписаться/i, /^follow/i],
  unfollow: [/^отписаться/i, /^подписки/i, /^unfollow/i, /^following/i],
  repost: [/^репост/i, /^repost/i],
  removeRepost: [/^удалить репост/i, /^убрать репост/i, /^remove repost/i, /^undo repost/i, /^remove/i],
  confirmRepost: [/^репост/i, /^repost/i],
  confirmUnfollow: [/^отписаться/i, /^unfollow/i],
  // Кнопка ответов в карточке поста — своей подписи в BUTTON_LABELS не было,
  // подписи лежали прямо в actions.ts, хотя весь смысл этого файла в том,
  // чтобы зацепки за вёрстку жили в одном месте.
  reply: [/^ответ/i, /^reply/i, /^comment/i],
} as const;

/**
 * Признак того, что мы разлогинены: страница предлагает войти.
 * Проверяется по нескольким приметам сразу — одна может отвалиться.
 */
export const LOGGED_OUT_HINTS = [
  /войти/i,
  /log in/i,
  /sign up/i,
  /создать аккаунт/i,
] as const;

/** Контейнер отдельного поста в ленте. */
export const POST_CONTAINER = '[data-pressable-container="true"]';

/** Ссылка на пост — из неё достаётся автор и shortcode. */
export const POST_PERMALINK = 'a[href*="/post/"]';

/** Страница поиска. `recent` — вкладка свежего, без неё Threads отдаёт топ. */
export const SEARCH_URL = (query: string, sort: "top" | "recent"): string => {
  const url = new URL("/search", URLS.home);
  url.searchParams.set("q", query);
  url.searchParams.set("serp_type", "default");
  if (sort === "recent") url.searchParams.set("filter", "recent");
  return url.toString();
};

/** Время публикации: Threads рисует его тегом <time> с машинным datetime. */
export const POST_TIME = "time[datetime]";

/**
 * Тело поста — единственный span[dir="auto"] внутри карточки, у которого нет
 * предка-ссылки и нет предка-кнопки: ник лежит в ссылке на профиль, тема — в
 * ссылке на поиск (href начинается с /search), возраст поста — в ссылке на
 * сам пост рядом с <time>, счётчики — внутри role="button". Если кандидатов
 * несколько (например, под цитатой лежит текст цитируемого поста), берём
 * самый длинный — см. actions.ts, textOf().
 */
export const POST_TEXT_SPAN = 'span[dir="auto"]';
export const POST_TEXT_EXCLUDE = 'a[href], [role="button"]';

/**
 * Медиа поста отличаем от аватара автора не положением в разметке — на живой
 * странице аватар может лежать и вовсе вне ссылок, — а подписью и
 * отрисованным размером. У аватара alt вида «…'s profile picture» или
 * «фото профиля», и рисуется он 36×36. Настоящее медиа — от нескольких сотен
 * пикселей по ширине, подпись у него другая (или пустая). Элемент <picture>
 * отдельно не считаем: внутри него тот же <img>, было бы задвоение.
 */
export const POST_MEDIA = {
  image: "img",
  video: "video",
  avatarAltPattern: "profile picture|фото профиля",
  minWidth: 100,
  // У видео поверх самого <video> лежит <img>-превью кадра того же размера —
  // без этого допуска на дробные пиксели вёрстки такое превью посчиталось бы
  // отдельной картинкой. Логика сравнения — countMedia() в cards.ts.
  sizeTolerance: 2,
} as const;
