import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { iconButtonChromeStyle, mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { getDesktopHost, type DesktopFindResult } from "@/desktop/host";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import type { Theme } from "@/styles/theme";

const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedX = withUnistyles(X);
const ThemedTextInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

const EMPTY_RESULT: DesktopFindResult = {
  activeMatchOrdinal: 0,
  matches: 0,
  finalUpdate: true,
};

function isFindResult(value: unknown): value is DesktopFindResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return typeof result.activeMatchOrdinal === "number" && typeof result.matches === "number";
}

/** Subscribes to a main-process event for as long as the bar is mounted. */
function useDesktopEvent(event: string, handler: (payload: unknown) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!getDesktopHost()?.events?.on) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listenToDesktopEvent(event, (payload: unknown) => {
      handlerRef.current(payload);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
        } else {
          unlisten = dispose;
        }
        return undefined;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}

interface FindBarButtonProps {
  accessibilityLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onPress: () => void;
  testID: string;
}

function FindBarButton({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  testID,
}: FindBarButtonProps): ReactElement {
  const style = useMemo(
    () =>
      ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) =>
        iconButtonChromeStyle({
          size: "small",
          state: { hovered: Boolean(hovered), pressed },
          disabled,
        }),
    [disabled],
  );

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={style}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

function formatCounter(input: {
  hasMatches: boolean;
  hasQuery: boolean;
  result: DesktopFindResult;
  t: (key: string, options?: Record<string, unknown>) => string;
}): string {
  if (input.hasMatches) {
    return input.t("desktop.find.matches", {
      current: input.result.activeMatchOrdinal,
      total: input.result.matches,
    });
  }
  return input.hasQuery ? input.t("desktop.find.noMatches") : "";
}

/**
 * The desktop find bar. It drives Chromium's own find-in-page in the main
 * process, which searches the active browser pane when there is one and the
 * Paseo window itself otherwise. Terminal panes draw their scrollback to a
 * canvas, so their text is not part of that search.
 */
export function FindInPageBar(): ReactElement | null {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<DesktopFindResult>(EMPTY_RESULT);
  const [hasQuery, setHasQuery] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const queryRef = useRef("");

  const runFind = useCallback((forward: boolean, findNext: boolean) => {
    const query = queryRef.current;
    const find = getDesktopHost()?.find;
    if (query.length === 0) {
      setResult(EMPTY_RESULT);
      void find?.stop?.("clearSelection");
      return;
    }
    void find?.start?.({ query, forward, findNext });
  }, []);

  const focusInput = useCallback(() => {
    const input = inputRef.current;
    input?.focus();
    const node = input?.getNativeRef?.() as { select?: () => void } | null | undefined;
    node?.select?.();
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setResult(EMPTY_RESULT);
    // The input unmounts with the bar, so the query has to go with it or
    // Find Next would keep advancing a search the user can no longer see.
    queryRef.current = "";
    setHasQuery(false);
    void getDesktopHost()?.find?.stop?.("clearSelection");
  }, []);

  useDesktopEvent("find-open", () => {
    setVisible(true);
    // Reopening over an existing query selects it, so the next keystroke
    // replaces the search the way every other find bar behaves.
    requestAnimationFrame(focusInput);
  });

  useDesktopEvent("find-next", () => {
    if (queryRef.current.length > 0) {
      setVisible(true);
      runFind(true, true);
    }
  });

  useDesktopEvent("find-previous", () => {
    if (queryRef.current.length > 0) {
      setVisible(true);
      runFind(false, true);
    }
  });

  useDesktopEvent("find-result", (payload) => {
    if (isFindResult(payload)) {
      setResult(payload);
    }
  });

  useEffect(() => {
    return () => {
      void getDesktopHost()?.find?.stop?.("clearSelection");
    };
  }, []);

  const handleChangeText = useCallback(
    (text: string) => {
      queryRef.current = text;
      setHasQuery(text.length > 0);
      runFind(true, false);
    },
    [runFind],
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent.key;
      if (key === "Escape") {
        close();
        return;
      }
      if (key !== "Enter") {
        return;
      }
      const shiftHeld = (event as unknown as { shiftKey?: boolean }).shiftKey === true;
      runFind(!shiftHeld, true);
    },
    [close, runFind],
  );

  const findNextMatch = useCallback(() => {
    focusInput();
    runFind(true, true);
  }, [focusInput, runFind]);

  const findPreviousMatch = useCallback(() => {
    focusInput();
    runFind(false, true);
  }, [focusInput, runFind]);

  if (!visible) {
    return null;
  }

  const hasMatches = result.matches > 0;
  const counter = formatCounter({ hasMatches, hasQuery, result, t });

  return (
    <View style={styles.bar} testID="find-in-page-bar">
      <ThemedTextInput
        ref={inputRef}
        autoFocus
        blurOnSubmit={false}
        initialValue=""
        onChangeText={handleChangeText}
        onKeyPress={handleKeyPress}
        placeholder={t("desktop.find.placeholder")}
        accessibilityLabel={t("desktop.find.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID="find-in-page-input"
      />
      <Text style={styles.counter} testID="find-in-page-counter">
        {counter}
      </Text>
      <FindBarButton
        accessibilityLabel={t("desktop.find.previous")}
        disabled={!hasMatches}
        onPress={findPreviousMatch}
        testID="find-in-page-previous"
      >
        <ThemedChevronUp size={14} uniProps={mutedIconColorMapping} />
      </FindBarButton>
      <FindBarButton
        accessibilityLabel={t("desktop.find.next")}
        disabled={!hasMatches}
        onPress={findNextMatch}
        testID="find-in-page-next"
      >
        <ThemedChevronDown size={14} uniProps={mutedIconColorMapping} />
      </FindBarButton>
      <FindBarButton
        accessibilityLabel={t("desktop.find.close")}
        onPress={close}
        testID="find-in-page-close"
      >
        <ThemedX size={14} uniProps={mutedIconColorMapping} />
      </FindBarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    zIndex: 1000,
  },
  input: {
    width: 180,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontFamily: theme.fontFamily.ui,
    paddingVertical: theme.spacing[1],
  },
  counter: {
    minWidth: 56,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
