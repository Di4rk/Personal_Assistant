import React from "react";
import { SsoLoginScreen } from "./SsoLoginScreen";

interface GenesisModalProps {
  onComplete: (nickname?: string, major?: string) => void | Promise<void>;
}

export const GenesisModal: React.FC<GenesisModalProps> = ({ onComplete }) => {
  return <SsoLoginScreen mode="onboarding" onComplete={onComplete} />;
};

export default GenesisModal;
