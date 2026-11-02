import { ButtonLink } from "../components/Button";
import { EmptyState } from "../components/States";

export default function NotFound() {
  return (
    <div className="page page--narrow">
      <EmptyState art="search" title="Страница не найдена" action={<ButtonLink to="/">На главную</ButtonLink>}>
        Такой страницы нет — возможно, ссылка устарела.
      </EmptyState>
    </div>
  );
}
