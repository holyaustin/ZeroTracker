import "./src/background/locationTask";   // must be imported first: the OS can start the app in the background just to run this task
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
