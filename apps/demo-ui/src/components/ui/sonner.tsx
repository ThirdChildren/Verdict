import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/components/ThemeProvider";

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      toastOptions={{ classNames: { toast: "!text-base" } }}
      {...props}
    />
  );
}
