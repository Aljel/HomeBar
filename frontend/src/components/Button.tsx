import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router";
import { Icon, type IconName } from "./Icon";
import "./button.css";

export type ButtonVariant = "default" | "primary" | "quiet" | "danger";

interface Look {
  variant?: ButtonVariant;
  /** md = 36px (default everywhere); lg = 44px, only for a single full-width action on phones */
  size?: "md" | "lg";
  icon?: IconName;
  iconEnd?: IconName;
  block?: boolean;
}

/** Class list for anything that should look like a button (e.g. a <label> for a file input). */
export function buttonClass({ variant = "default", size = "md", block }: Look = {}, extra?: string): string {
  return ["btn", `btn--${variant}`, size === "lg" && "btn--lg", block && "btn--block", extra].filter(Boolean).join(" ");
}

function Content({ icon, iconEnd, children }: { icon?: IconName; iconEnd?: IconName; children?: ReactNode }) {
  return (
    <>
      {icon && <Icon name={icon} />}
      {children !== undefined && children !== null && <span className="btn__label">{children}</span>}
      {iconEnd && <Icon name={iconEnd} />}
    </>
  );
}

type ButtonProps = Look & ButtonHTMLAttributes<HTMLButtonElement>;

/** The one button. Outline by default, `primary` = solid green (max one per view). */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, iconEnd, block, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass({ variant, size, block }, className)} {...rest}>
      <Content icon={icon} iconEnd={iconEnd}>
        {children}
      </Content>
    </button>
  );
});

type ButtonLinkProps = Look & LinkProps;

export function ButtonLink({ variant, size, icon, iconEnd, block, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClass({ variant, size, block }, className)} {...rest}>
      <Content icon={icon} iconEnd={iconEnd}>
        {children as ReactNode}
      </Content>
    </Link>
  );
}

interface IconLook {
  icon: IconName;
  /** accessible name; also shown as a native tooltip */
  label: string;
  /** outline = 1px circle border; plain = borderless until hover */
  look?: "outline" | "plain";
  tone?: "heart" | "danger";
  filled?: boolean;
}

function iconClass({ look = "outline", tone }: Pick<IconLook, "look" | "tone">, extra?: string) {
  return ["icon-btn", `icon-btn--${look}`, tone && `icon-btn--${tone}`, extra].filter(Boolean).join(" ");
}

type IconButtonProps = IconLook & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

export function IconButton({ icon, label, look, tone, filled, className, type = "button", title, ...rest }: IconButtonProps) {
  return (
    <button type={type} className={iconClass({ look, tone }, className)} aria-label={label} title={title ?? label} {...rest}>
      <Icon name={icon} filled={filled} />
    </button>
  );
}

type IconLinkProps = IconLook & Omit<LinkProps, "children">;

export function IconLink({ icon, label, look, tone, filled, className, title, ...rest }: IconLinkProps) {
  return (
    <Link className={iconClass({ look, tone }, className)} aria-label={label} title={title ?? label} {...rest}>
      <Icon name={icon} filled={filled} />
    </Link>
  );
}
