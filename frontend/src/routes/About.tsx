import { PageText } from "../components/PageText";
import "./about.css";

const FALLBACK = `HomeBar — маленький домашний бар и кухня. Здесь хранятся рецепты, которые хозяин любит готовить для друзей.

Гости могут выбрать напиток в **меню** и заказать его с телефона — хозяин увидит заказ у стойки.`;

export default function About() {
  return (
    <div className="page page--narrow about">
      <article className="panel panel--pad about__article">
        <PageText slug="about" fallbackTitle="О баре" fallbackBody={FALLBACK} />
      </article>
    </div>
  );
}
