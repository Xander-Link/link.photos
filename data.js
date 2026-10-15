// Содержимое галереи.
//
// photos — либо число (столько фото-заглушек с picsum.photos, пока нет своих),
// либо список путей к своим фото, например:
//   { title: 'Владивосток', photos: ['photos/vlad/01.jpg', 'photos/vlad/02.jpg'] }
// Если в пути есть {size}, вместо него подставится нужная ширина (64…1600),
// чтобы мелкие плитки грузили уменьшенные версии: 'photos/vlad/01-{size}.jpg'.
window.GALLERY = {
  title: ['Что в галерее', 'у Саши Линченко'],
  groups: [
    { title: 'Отпуск', photos: 36 },
    { title: 'Владивосток', photos: 52 },
    { title: 'Москва', photos: 40 },
    { title: 'Питер', photos: 24 },
    { title: 'Дача', photos: 18 },
    { title: 'Горы', photos: 30 },
    { title: 'Друзья', photos: 22 },
    { title: 'Новый год', photos: 21 },
  ],
};
